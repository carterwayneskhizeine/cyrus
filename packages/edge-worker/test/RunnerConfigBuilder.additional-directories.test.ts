import type { CyrusAgentSession, ILogger, RepositoryConfig } from "cyrus-core";
import { describe, expect, it } from "vitest";
import {
	type IChatToolResolver,
	type IMcpConfigProvider,
	type IRunnerSelector,
	RunnerConfigBuilder,
	resolveIssueMcpConfigPath,
} from "../src/RunnerConfigBuilder.js";

const silentLogger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

function makeBuilder(
	runnerType: "claude" | "codex" = "claude",
): RunnerConfigBuilder {
	const chatToolResolver: IChatToolResolver = {
		buildChatAllowedTools: () => ["Read(**)"],
	};
	const mcpConfigProvider: IMcpConfigProvider = {
		buildMcpConfig: () => ({}),
		buildMergedMcpConfigPath: () => undefined,
	};
	const runnerSelector: IRunnerSelector = {
		determineRunnerSelection: () => ({ runnerType }),
		getDefaultModelForRunner: () => "opus",
		getDefaultFallbackModelForRunner: () => "sonnet",
	};
	return new RunnerConfigBuilder(
		chatToolResolver,
		mcpConfigProvider,
		runnerSelector,
	);
}

function makeRepository(): RepositoryConfig {
	return {
		id: "repo-a",
		name: "Repo A",
		repositoryPath: "/repos/repo-a",
		allowedTools: [],
	} as unknown as RepositoryConfig;
}

function makeSession(
	workspace: CyrusAgentSession["workspace"],
): CyrusAgentSession {
	return {
		issueId: "issue-1",
		issue: { identifier: "ABC-1" },
		workspace,
	} as unknown as CyrusAgentSession;
}

function buildIssueConfig(
	session: CyrusAgentSession,
	extra: {
		operatorDirectories?: string[];
		runnerType?: "claude" | "codex";
		allowedTools?: string[];
		permissionMode?: "default" | "acceptEdits" | "bypassPermissions";
	} = {},
) {
	return makeBuilder(extra.runnerType ?? "claude").buildIssueConfig({
		session,
		repository: makeRepository(),
		sessionId: "sess-1",
		systemPrompt: "test",
		allowedTools: extra.allowedTools ?? ["Read(**)"],
		allowedDirectories: ["/repos/repo-a"],
		operatorDirectories: extra.operatorDirectories,
		permissionMode: extra.permissionMode,
		disallowedTools: [],
		cyrusHome: "/tmp/cyrus-home",
		linearWorkspaceId: "ws-1",
		logger: silentLogger,
		onMessage: () => {},
		onError: () => {},
		requireLinearWorkspaceId: () => "ws-1",
	});
}

describe("RunnerConfigBuilder additionalDirectories (multi-repo skill discovery)", () => {
	it("registers each multi-repo sub-worktree as an additional directory", () => {
		const session = makeSession({
			path: "/ws/root",
			isGitWorktree: true,
			repoPaths: {
				"repo-a": "/ws/root/repo-a",
				"repo-b": "/ws/root/repo-b",
			},
		} as unknown as CyrusAgentSession["workspace"]);

		const { config } = buildIssueConfig(session);

		expect(config.workingDirectory).toBe("/ws/root");
		expect(config.additionalDirectories).toEqual([
			"/ws/root/repo-a",
			"/ws/root/repo-b",
		]);
	});

	it("omits additionalDirectories for single-repo sessions (cwd is the worktree)", () => {
		const session = makeSession({
			path: "/ws/repo-a-worktree",
			isGitWorktree: true,
		} as unknown as CyrusAgentSession["workspace"]);

		const { config } = buildIssueConfig(session);

		expect(config.workingDirectory).toBe("/ws/repo-a-worktree");
		expect(config.additionalDirectories).toBeUndefined();
	});

	it("excludes the cwd itself from additionalDirectories", () => {
		// A repoPaths entry equal to the workspace root must not be re-added as
		// an --add-dir (it is already the cwd).
		const session = makeSession({
			path: "/ws/root",
			isGitWorktree: true,
			repoPaths: {
				"repo-a": "/ws/root",
				"repo-b": "/ws/root/repo-b",
			},
		} as unknown as CyrusAgentSession["workspace"]);

		const { config } = buildIssueConfig(session);

		expect(config.additionalDirectories).toEqual(["/ws/root/repo-b"]);
	});
});

describe("RunnerConfigBuilder operatorDirectories (claudeAllowedDirectories)", () => {
	const singleRepoSession = makeSession({
		path: "/ws/repo-a-worktree",
		isGitWorktree: true,
	} as unknown as CyrusAgentSession["workspace"]);

	it("grants Edit/Write patterns and --add-dir roots for a writable Claude session", () => {
		const { config } = buildIssueConfig(singleRepoSession, {
			operatorDirectories: ["/root/Code"],
			allowedTools: ["Read", "Edit", "Write", "Bash"],
		});

		expect(config.workingDirectory).toBe("/ws/repo-a-worktree");
		expect(config.additionalDirectories).toEqual(["/root/Code"]);
		expect(config.allowedTools).toEqual(
			expect.arrayContaining(["Edit(//root/Code/**)", "Write(//root/Code/**)"]),
		);
		// Original bare entries stay untouched.
		expect(config.allowedTools).toEqual(
			expect.arrayContaining(["Read", "Edit", "Write", "Bash"]),
		);
	});

	it("merges operator dirs with multi-repo sub-worktrees without duplicates", () => {
		const session = makeSession({
			path: "/ws/root",
			isGitWorktree: true,
			repoPaths: {
				"repo-a": "/ws/root/repo-a",
			},
		} as unknown as CyrusAgentSession["workspace"]);
		const { config } = buildIssueConfig(session, {
			operatorDirectories: ["/root/Code", "/root/Code"],
			allowedTools: ["Read", "Edit", "Write"],
		});

		expect(config.additionalDirectories).toEqual([
			"/ws/root/repo-a",
			"/root/Code",
		]);
	});

	it("keeps read-only sessions read-only while still registering the dirs", () => {
		const { config } = buildIssueConfig(singleRepoSession, {
			operatorDirectories: ["/root/Code"],
			allowedTools: ["Read", "WebFetch"],
		});

		expect(config.additionalDirectories).toEqual(["/root/Code"]);
		expect(config.allowedTools).not.toEqual(
			expect.arrayContaining(["Edit(//root/Code/**)", "Write(//root/Code/**)"]),
		);
		expect(config.allowedTools).toEqual(["Read", "WebFetch"]);
	});

	it("does not add --add-dir roots or patterns for non-Claude runners", () => {
		const { config, runnerType } = buildIssueConfig(singleRepoSession, {
			operatorDirectories: ["/root/Code"],
			runnerType: "codex",
			allowedTools: ["Read", "Edit", "Write"],
		});

		expect(runnerType).toBe("codex");
		expect(config.additionalDirectories).toBeUndefined();
		expect(config.allowedTools).toEqual(["Read", "Edit", "Write"]);
	});
});

describe("resolveIssueMcpConfigPath", () => {
	it("uses platform-level MCP configs when the repo inherits platform tools", () => {
		const repository = makeRepository();
		const result = resolveIssueMcpConfigPath(
			repository,
			["/home/user/.cyrus/mcp-configs/mcp-supabase.json"],
			() => "/repo/.mcp.json",
		);

		expect(result).toBe("/home/user/.cyrus/mcp-configs/mcp-supabase.json");
	});

	it("uses repo MCP config when the repo owns an allowedTools override", () => {
		const repository = {
			...makeRepository(),
			allowedTools: ["Read(**)", "mcp__repo"],
			mcpConfigPath: "/repo/.mcp.json",
		} as unknown as RepositoryConfig;
		const result = resolveIssueMcpConfigPath(
			repository,
			["/home/user/.cyrus/mcp-configs/mcp-supabase.json"],
			(repo) => (repo as RepositoryConfig).mcpConfigPath,
		);

		expect(result).toBe("/repo/.mcp.json");
	});
});

describe("RunnerConfigBuilder permissionMode (claudePermissionMode override)", () => {
	function singleRepoSession(): CyrusAgentSession {
		return makeSession({
			path: "/ws/repo-a-worktree",
			isGitWorktree: true,
		} as unknown as CyrusAgentSession["workspace"]);
	}

	it("forwards permissionMode for claude sessions", () => {
		const { config } = buildIssueConfig(singleRepoSession(), {
			permissionMode: "bypassPermissions",
		});

		expect(config.permissionMode).toBe("bypassPermissions");
	});

	it("does not set permissionMode for non-claude runners", () => {
		const { config } = buildIssueConfig(singleRepoSession(), {
			runnerType: "codex",
			permissionMode: "bypassPermissions",
		});

		expect(config.permissionMode).toBeUndefined();
	});

	it("omits permissionMode when not configured (runner default applies)", () => {
		const { config } = buildIssueConfig(singleRepoSession());

		expect(config.permissionMode).toBeUndefined();
	});
});
