import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  decodePostHogCloudProtocolEntry,
  githubPullRequestReference,
  mapPostHogCloudProtocolEntry,
} from "./PostHogCloudProtocol.ts";
import { PostHogCloudRunSession } from "./PostHogCloudRunSession.ts";

const timestamp = "2026-08-27T12:00:00.000Z";
const threadId = ThreadId.make("cloud-thread");
const turnId = TurnId.make("cloud-turn");

function makeSession() {
  return new PostHogCloudRunSession({
    taskId: undefined,
    runId: undefined,
    repository: "posthog/t3code",
    reportId: undefined,
    activeTurnId: turnId,
    session: {
      provider: ProviderDriverKind.make("posthogCloud"),
      providerInstanceId: ProviderInstanceId.make("posthogCloud"),
      status: "running",
      runtimeMode: "full-access",
      threadId,
      activeTurnId: turnId,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  });
}

describe("PostHogCloudProtocol", () => {
  it("rejects unsupported and malformed external messages", () => {
    assert.equal(decodePostHogCloudProtocolEntry(null), undefined);
    assert.equal(
      decodePostHogCloudProtocolEntry({
        notification: { method: "session/update", params: { update: { sessionUpdate: "plan" } } },
      })?.entry.type,
      "session-update",
    );
    assert.equal(
      decodePostHogCloudProtocolEntry({
        notification: {
          method: "session/update",
          params: { update: { sessionUpdate: "agent_message_chunk", content: 42 } },
        },
      }),
      undefined,
    );
  });

  it.effect("maps typed stream messages while owning projection state", () =>
    Effect.gen(function* () {
      const session = makeSession();
      let sequence = 0;
      const map = (entry: unknown) =>
        mapPostHogCloudProtocolEntry(session, entry, (source, createdAt) =>
          Effect.succeed({
            eventId: EventId.make(`event-${++sequence}`),
            provider: ProviderDriverKind.make("posthogCloud"),
            providerInstanceId: ProviderInstanceId.make("posthogCloud"),
            threadId,
            turnId,
            createdAt: createdAt ?? timestamp,
            raw: { source: "acp.posthog-cloud.extension", payload: source },
          }),
        );
      const entries = [
        {
          type: "permission_request",
          requestId: "question-1",
          toolCall: {
            title: "Choose a framework",
            _meta: {
              codeToolKind: "question",
              questions: [
                {
                  question: "Which framework?",
                  header: "Framework",
                  options: [{ label: "React", description: "Use React" }],
                },
              ],
            },
          },
          options: [{ optionId: "option_0", kind: "allow_once", name: "React" }],
        },
        notification("session/update", {
          update: { sessionUpdate: "agent_message_chunk", content: { text: "Before" } },
        }),
        notification("session/update", {
          update: { sessionUpdate: "agent_message", content: { text: "Before" } },
        }),
        notification("session/update", {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "bash-1",
            title: "/bin/bash -lc pwd",
            kind: "execute",
            status: "in_progress",
          },
        }),
        notification("session/update", {
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "bash-1",
            status: "completed",
            content: [{ type: "content", content: { type: "text", text: "---\n/root/posthog" } }],
          },
        }),
        notification("session/update", {
          update: { sessionUpdate: "agent_message", content: { text: "After" } },
        }),
        notification("_posthog/turn_complete", {}),
      ];

      const events = (yield* Effect.forEach(
        entries,
        map,
      )).flat() as ReadonlyArray<ProviderRuntimeEvent>;
      assert.deepStrictEqual(
        events.map((event) => event.type),
        [
          "user-input.requested",
          "item.started",
          "content.delta",
          "item.completed",
          "item.started",
          "item.completed",
          "item.started",
          "content.delta",
          "item.completed",
          "turn.completed",
        ],
      );
      const userInput = events.find((event) => event.type === "user-input.requested");
      assert.deepStrictEqual(userInput?.payload.questions, [
        {
          id: "Which framework?",
          header: "Framework",
          question: "Which framework?",
          options: [{ label: "React", description: "Use React" }],
          multiSelect: false,
        },
      ]);
      const deltas = events
        .filter((event) => event.type === "content.delta")
        .map((event) => event.payload.delta);
      assert.deepStrictEqual(deltas, ["Before", "After"]);
      const tool = events.find(
        (event) => event.type === "item.completed" && event.itemId === RuntimeItemId.make("bash-1"),
      );
      assert.equal(tool?.type, "item.completed");
      if (tool?.type === "item.completed") {
        assert.equal(tool.payload.title, "/bin/bash -lc pwd");
        assert.equal(tool.payload.detail, "---\n/root/posthog");
      }
      assert.equal(session.session.status, "ready");
      assert.equal(session.activeTurnId, undefined);
    }),
  );

  it("normalizes GitHub pull request URLs at the provider boundary", () => {
    assert.deepStrictEqual(
      githubPullRequestReference("https://github.com/posthog/t3code/pull/42", "posthog/t3code"),
      {
        repository: "posthog/t3code",
        number: 42,
        url: "https://github.com/posthog/t3code/pull/42",
      },
    );
    assert.equal(githubPullRequestReference("https://example.com/pull/42", undefined), undefined);
  });

  it.effect("closes open content without completing an ownerless turn", () =>
    Effect.gen(function* () {
      const session = makeSession();
      let sequence = 0;
      const map = (entry: unknown) =>
        mapPostHogCloudProtocolEntry(session, entry, (source, createdAt) =>
          Effect.succeed({
            eventId: EventId.make(`ownerless-${++sequence}`),
            provider: ProviderDriverKind.make("posthogCloud"),
            providerInstanceId: ProviderInstanceId.make("posthogCloud"),
            threadId,
            createdAt: createdAt ?? timestamp,
            raw: { source: "acp.posthog-cloud.extension", payload: source },
          }),
        );

      yield* map(
        notification("session/update", {
          update: { sessionUpdate: "agent_message_chunk", content: { text: "Final answer" } },
        }),
      );
      session.activeTurnId = undefined;
      const events = yield* map(notification("_posthog/turn_complete", {}));

      assert.deepStrictEqual(
        events.map((event) => event.type),
        ["item.completed"],
      );
      assert.equal(session.assistantItemId, undefined);
      assert.equal(session.session.status, "running");
    }),
  );

  it.effect(
    "reconstructs an implicit turn for output that arrives after the tracked turn ended",
    () =>
      Effect.gen(function* () {
        const session = makeSession();
        session.finishTurn(timestamp);
        let sequence = 0;
        const map = (entry: unknown) =>
          mapPostHogCloudProtocolEntry(session, entry, (source, createdAt) =>
            Effect.succeed({
              eventId: EventId.make(`implicit-${++sequence}`),
              provider: ProviderDriverKind.make("posthogCloud"),
              providerInstanceId: ProviderInstanceId.make("posthogCloud"),
              threadId,
              createdAt: createdAt ?? timestamp,
              raw: { source: "acp.posthog-cloud.extension", payload: source },
            }),
          );

        const output = yield* map(
          notification("session/update", {
            update: { sessionUpdate: "agent_message_chunk", content: { text: "Still working" } },
          }),
        );
        const completion = yield* map(notification("_posthog/turn_complete", {}));

        assert.deepStrictEqual(
          [...output, ...completion].map((event) => event.type),
          ["turn.started", "item.started", "content.delta", "item.completed", "turn.completed"],
        );
        assert.equal(output[0]?.turnId, output[1]?.turnId);
        assert.equal(session.session.status, "ready");
      }),
  );

  it.effect("keeps TaskRun startup separate from turn activity", () =>
    Effect.gen(function* () {
      const session = makeSession();
      session.finishTurn(timestamp);
      const events = yield* mapPostHogCloudProtocolEntry(
        session,
        notification("_posthog/run_started", {}),
        (source, createdAt) =>
          Effect.succeed({
            eventId: EventId.make("run-started"),
            provider: ProviderDriverKind.make("posthogCloud"),
            providerInstanceId: ProviderInstanceId.make("posthogCloud"),
            threadId,
            createdAt: createdAt ?? timestamp,
            raw: { source: "acp.posthog-cloud.extension", payload: source },
          }),
      );

      assert.deepStrictEqual(events, []);
      assert.equal(session.session.status, "ready");
      assert.equal(session.activeTurnId, undefined);
    }),
  );

  it.effect("maps PostHog background turns to a complete visible T3 turn", () =>
    Effect.gen(function* () {
      const session = makeSession();
      session.finishTurn(timestamp);
      let sequence = 0;
      const map = (entry: unknown) =>
        mapPostHogCloudProtocolEntry(session, entry, (source, createdAt) =>
          Effect.succeed({
            eventId: EventId.make(`background-${++sequence}`),
            provider: ProviderDriverKind.make("posthogCloud"),
            providerInstanceId: ProviderInstanceId.make("posthogCloud"),
            threadId,
            createdAt: createdAt ?? timestamp,
            raw: { source: "acp.posthog-cloud.extension", payload: source },
          }),
        );

      const events = (yield* Effect.forEach(
        [
          notification("_posthog/background_turn_started", {}),
          notification("session/update", {
            update: { sessionUpdate: "agent_message_chunk", content: { text: "Background reply" } },
          }),
          notification("_posthog/background_turn_complete", { stopReason: "end_turn" }),
        ],
        map,
      )).flat();

      assert.deepStrictEqual(
        events.map((event) => event.type),
        ["turn.started", "item.started", "content.delta", "item.completed", "turn.completed"],
      );
      assert.equal(session.activeTurnId, undefined);
    }),
  );

  it.effect("renders cross-surface prompts while suppressing T3's own prompt echo", () =>
    Effect.gen(function* () {
      const session = makeSession();
      session.registerLocalUserEcho("sent from T3");
      let sequence = 0;
      const map = (entry: unknown) =>
        mapPostHogCloudProtocolEntry(session, entry, (source, createdAt) =>
          Effect.succeed({
            eventId: EventId.make(`prompt-${++sequence}`),
            provider: ProviderDriverKind.make("posthogCloud"),
            providerInstanceId: ProviderInstanceId.make("posthogCloud"),
            threadId,
            turnId,
            createdAt: createdAt ?? timestamp,
            raw: { source: "acp.posthog-cloud.extension", payload: source },
          }),
        );

      const local = yield* map(promptRequest(1, "sent from T3", true));
      const external = yield* map(promptRequest(2, "sent from PostHog", true));

      assert.deepStrictEqual(local, []);
      assert.deepStrictEqual(
        external.map((event) => event.type),
        ["item.completed"],
      );
      assert.equal(external[0]?.type, "item.completed");
      if (external[0]?.type === "item.completed") {
        assert.equal(external[0].payload.itemType, "user_message");
        assert.equal(external[0].payload.detail, "sent from PostHog");
      }
    }),
  );

  it.effect("keeps pull request and CI progress as separate durable results", () =>
    Effect.gen(function* () {
      const session = makeSession();
      let sequence = 0;
      const map = (entry: unknown) =>
        mapPostHogCloudProtocolEntry(session, entry, (source, createdAt) =>
          Effect.succeed({
            eventId: EventId.make(`progress-${++sequence}`),
            provider: ProviderDriverKind.make("posthogCloud"),
            providerInstanceId: ProviderInstanceId.make("posthogCloud"),
            threadId,
            turnId,
            createdAt: createdAt ?? timestamp,
            raw: { source: "acp.posthog-cloud.extension", payload: source },
          }),
        );

      const pullRequestEvents = yield* map(
        notification("_posthog/progress", {
          step: "pr",
          status: "completed",
          label: "Opened pull request",
          detail: "https://github.com/posthog/t3code/pull/42",
        }),
      );
      const ciEvents = yield* map(
        notification("_posthog/progress", {
          step: "ci",
          status: "in_progress",
          label: "Keeping CI green",
        }),
      );

      assert.deepStrictEqual(
        pullRequestEvents.map((event) => event.type),
        ["task.progress", "thread.metadata.updated"],
      );
      const pullRequestProgress = pullRequestEvents[0];
      const ciProgress = ciEvents[0];
      assert.equal(pullRequestProgress?.type, "task.progress");
      assert.equal(ciProgress?.type, "task.progress");
      if (pullRequestProgress?.type === "task.progress" && ciProgress?.type === "task.progress") {
        assert.equal(
          pullRequestProgress.payload.taskId,
          RuntimeTaskId.make("posthog-cloud-pull-request"),
        );
        assert.equal(ciProgress.payload.taskId, RuntimeTaskId.make("posthog-cloud-ci"));
      }
      const metadata = pullRequestEvents[1];
      assert.equal(metadata?.type, "thread.metadata.updated");
      if (metadata?.type === "thread.metadata.updated") {
        assert.deepStrictEqual(metadata.payload.pullRequest, {
          repository: "posthog/t3code",
          number: 42,
          url: "https://github.com/posthog/t3code/pull/42",
        });
      }
    }),
  );
});

function notification(method: string, params: unknown) {
  return { type: "notification", notification: { method, params } };
}

function promptRequest(id: number, text: string, steer: boolean) {
  return {
    type: "notification",
    notification: {
      id,
      method: "session/prompt",
      params: {
        prompt: [{ type: "text", text }],
        _meta: { steer },
      },
    },
  };
}
