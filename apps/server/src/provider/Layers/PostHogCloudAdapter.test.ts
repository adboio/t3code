import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  PostHogCloudRunId,
  PostHogCloudTaskId,
  PostHogRequestError,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type PostHogCloudRun,
  type PostHogCloudTask,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { PostHogCloudClient } from "../../posthog/PostHogCloudClient.ts";
import { makePostHogCloudAdapter } from "./PostHogCloudAdapter.ts";

const timestamp = "2026-08-27T12:00:00.000Z";
const taskId = PostHogCloudTaskId.make("10000000-0000-4000-8000-000000000001");
const runOneId = PostHogCloudRunId.make("20000000-0000-4000-8000-000000000001");
const runTwoId = PostHogCloudRunId.make("20000000-0000-4000-8000-000000000002");

function cloudRun(id: typeof runOneId, status: PostHogCloudRun["status"]): PostHogCloudRun {
  return {
    id,
    task: taskId,
    status,
    artifacts: [],
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function cloudTask(latestRun: PostHogCloudRun | null): PostHogCloudTask {
  return {
    id: taskId,
    title: "Cloud task",
    description: "",
    repository: "posthog/t3code",
    repositories: ["posthog/t3code"],
    latest_run: latestRun,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

describe("PostHogCloudAdapter", () => {
  it.effect("routes turns, attachments, interruption, and run shutdown", () => {
    const runCalls: Array<Parameters<PostHogCloudClient["Service"]["runTask"]>[0]> = [];
    const commandCalls: Array<Parameters<PostHogCloudClient["Service"]["commandRun"]>[0]> = [];
    const cancelCalls: Array<Parameters<PostHogCloudClient["Service"]["cancelRun"]>[0]> = [];
    const uploadCalls: Array<Parameters<PostHogCloudClient["Service"]["uploadRunArtifacts"]>[0]> =
      [];
    const createCalls: Array<Parameters<PostHogCloudClient["Service"]["createTask"]>[0]> = [];
    const streamInputs: Array<Parameters<PostHogCloudClient["Service"]["streamRun"]>[0]> = [];
    let currentRun = cloudRun(runOneId, "in_progress");
    let streamCalls = 0;
    let logCalls = 0;

    const unused = () => Effect.die(new Error("Unexpected PostHog client call"));
    const posthog = PostHogCloudClient.of({
      listModels: unused,
      createTask: (input) =>
        Effect.sync(() => {
          createCalls.push(input);
          return cloudTask(null);
        }),
      runTask: (input) =>
        Effect.sync(() => {
          runCalls.push(input);
          const id = runCalls.length === 1 ? runOneId : runTwoId;
          currentRun = cloudRun(id, "in_progress");
          return cloudTask(currentRun);
        }),
      getRun: () => Effect.sync(() => currentRun),
      commandRun: (input) =>
        Effect.sync(() => {
          commandCalls.push(input);
          return {};
        }),
      cancelRun: (input) =>
        Effect.sync(() => {
          cancelCalls.push(input);
          currentRun = cloudRun(input.runId, "cancelled");
          return currentRun;
        }),
      uploadRunArtifacts: (input) =>
        Effect.sync(() => {
          uploadCalls.push(input);
          return [{ id: `artifact-${uploadCalls.length}`, name: input.artifacts[0]?.name }];
        }),
      readRunLogs: () =>
        Effect.sync(() => {
          logCalls += 1;
          return logCalls === 1
            ? '{"type":"notification","notification":{"method":"_posthog/progress","params":{"label":"Setting up sandbox"}}}'
            : "";
        }),
      streamRun: (input) =>
        Effect.sync(() => {
          streamInputs.push(input);
          return streamCalls++ === 0
            ? Stream.make({
                id: "event-1",
                event: "message",
                data: {
                  type: "notification",
                  notification: { method: "_posthog/turn_complete", params: {} },
                },
              })
            : Stream.never;
        }),
    });
    const fileSystem = FileSystem.makeNoop({
      readFile: () => Effect.succeed(new TextEncoder().encode("image bytes")),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make("cloud-thread");
        const modelSelection = {
          instanceId: ProviderInstanceId.make("posthogCloud"),
          model: "claude:claude-sonnet-4-5",
        };
        const adapter = yield* makePostHogCloudAdapter({
          instanceId: modelSelection.instanceId,
          posthog,
          fileSystem,
        });

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("posthogCloud"),
          repository: "posthog/t3code",
          reportId: "report-1",
          runtimeMode: "full-access",
          modelSelection,
        });

        const attachment = {
          type: "image" as const,
          id: "image-1",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 11,
        };
        const firstTurnEvents: ProviderRuntimeEvent[] = [];
        const firstTurnCompleted = yield* Deferred.make<void>();
        const firstTurnEventsFiber = yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              firstTurnEvents.push(event);
            }).pipe(
              Effect.andThen(
                event.type === "turn.completed"
                  ? Deferred.succeed(firstTurnCompleted, undefined)
                  : Effect.void,
              ),
            ),
          ),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* adapter.sendTurn({
          threadId,
          input: "Inspect this screenshot",
          attachments: [attachment],
          resolvedAttachments: [{ ...attachment, path: "/attachments/screenshot.png" }],
          modelSelection,
        });
        yield* Deferred.await(firstTurnCompleted);
        yield* Fiber.interrupt(firstTurnEventsFiber);
        assert.deepStrictEqual(
          firstTurnEvents.map((event) => event.type),
          ["turn.started", "task.progress", "task.progress", "turn.completed"],
        );
        const setupProgress = firstTurnEvents.filter((event) => event.type === "task.progress");
        assert.equal(setupProgress.length, 2);
        assert.equal(
          setupProgress.every((event) => event.payload.taskType === "provider_setup"),
          true,
        );
        assert.equal(streamInputs[0]?.startLatest, undefined);
        assert.equal(logCalls, 1);
        const firstRunSessions = yield* adapter.listSessions();
        assert.deepStrictEqual(firstRunSessions[0]?.resumeCursor, {
          schemaVersion: 1,
          runId: runOneId,
          lastEventId: "event-1",
          processedEntryCount: 1,
        });
        yield* adapter.sendTurn({ threadId, input: "Keep going", attachments: [], modelSelection });

        currentRun = cloudRun(runOneId, "completed");
        yield* adapter.sendTurn({
          threadId,
          input: "Resume with this screenshot",
          attachments: [attachment],
          resolvedAttachments: [{ ...attachment, id: "image-2", path: "/attachments/next.png" }],
          modelSelection,
        });
        yield* adapter.interruptTurn(threadId);
        yield* adapter.stopSession(threadId);
        yield* adapter.startSession({
          threadId: ThreadId.make("background-cloud-thread"),
          provider: ProviderDriverKind.make("posthogCloud"),
          runtimeMode: "full-access",
          modelSelection,
          runtimePayload: { schemaVersion: 1, taskId, repository: "posthog/t3code" },
          resumeCursor: { schemaVersion: 1, runId: runTwoId },
        });
        yield* adapter.stopAll();

        assert.deepStrictEqual(createCalls, [
          {
            title: "Inspect this screenshot",
            description: "",
            repository: "posthog/t3code",
            signalReportId: "report-1",
          },
        ]);
        assert.equal(runCalls.length, 2);
        assert.equal(runCalls[0]?.message, "");
        assert.equal(runCalls[0]?.resumeFromRunId, undefined);
        assert.equal(runCalls[1]?.message, "");
        assert.equal(runCalls[1]?.resumeFromRunId, runOneId);
        assert.deepStrictEqual(
          uploadCalls.map((call) => ({ runId: call.runId, base64: call.artifacts[0]?.base64 })),
          [
            { runId: runOneId, base64: "aW1hZ2UgYnl0ZXM=" },
            { runId: runTwoId, base64: "aW1hZ2UgYnl0ZXM=" },
          ],
        );
        assert.deepStrictEqual(
          commandCalls.map((call) => ({
            runId: call.runId,
            method: call.method,
            params: call.params,
          })),
          [
            {
              runId: runOneId,
              method: "user_message",
              params: {
                content: "Inspect this screenshot",
                artifact_ids: ["artifact-1"],
                steer: false,
              },
            },
            {
              runId: runOneId,
              method: "user_message",
              params: { content: "Keep going", steer: false },
            },
            {
              runId: runTwoId,
              method: "user_message",
              params: {
                content: "Resume with this screenshot",
                artifact_ids: ["artifact-2"],
                steer: false,
              },
            },
            { runId: runTwoId, method: "cancel", params: undefined },
          ],
        );
        assert.deepStrictEqual(cancelCalls, [{ taskId, runId: runTwoId }]);
        assert.equal(logCalls, 3);
        assert.equal(
          streamInputs.find((input) => input.runId === runTwoId)?.lastEventId,
          undefined,
        );

        const sessions = yield* adapter.listSessions();
        assert.equal(sessions[0]?.status, "closed");
        assert.deepStrictEqual(sessions[0]?.runtimePayload, {
          schemaVersion: 1,
          taskId,
          repository: "posthog/t3code",
        });
        assert.deepStrictEqual(sessions[0]?.resumeCursor, {
          schemaVersion: 1,
          runId: runTwoId,
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer));
  });

  it.effect("steers an active turn without opening a replacement turn", () => {
    const commandCalls: Array<Parameters<PostHogCloudClient["Service"]["commandRun"]>[0]> = [];
    const uploadCalls: Array<Parameters<PostHogCloudClient["Service"]["uploadRunArtifacts"]>[0]> =
      [];
    const unused = () => Effect.die(new Error("Unexpected PostHog client call"));
    const posthog = PostHogCloudClient.of({
      listModels: unused,
      createTask: unused,
      runTask: unused,
      getRun: () => Effect.succeed(cloudRun(runOneId, "in_progress")),
      commandRun: (input) =>
        Effect.sync(() => {
          commandCalls.push(input);
          return {};
        }),
      cancelRun: unused,
      uploadRunArtifacts: (input) =>
        Effect.sync(() => {
          uploadCalls.push(input);
          return [{ id: "artifact-steer", name: input.artifacts[0]?.name }];
        }),
      readRunLogs: () => Effect.succeed(""),
      streamRun: () => Effect.succeed(Stream.never),
    });
    const fileSystem = FileSystem.makeNoop({
      readFile: () => Effect.succeed(new TextEncoder().encode("steer image")),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const activeTurnId = TurnId.make("active-cloud-turn");
        const threadId = ThreadId.make("steered-cloud-thread");
        const modelSelection = {
          instanceId: ProviderInstanceId.make("posthogCloud"),
          model: "claude:claude-sonnet-4-5",
        };
        const adapter = yield* makePostHogCloudAdapter({
          instanceId: modelSelection.instanceId,
          posthog,
          fileSystem,
        });
        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("posthogCloud"),
          runtimeMode: "full-access",
          modelSelection,
          runtimePayload: {
            schemaVersion: 1,
            taskId,
            repository: "posthog/t3code",
            activeTurnId,
          },
          resumeCursor: { schemaVersion: 1, runId: runOneId },
        });
        const runtimeEvents: ProviderRuntimeEvent[] = [];
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        const attachment = {
          type: "image" as const,
          id: "steer-image",
          name: "steer.png",
          mimeType: "image/png",
          sizeBytes: 11,
          path: "/attachments/steer.png",
        };
        const result = yield* adapter.sendTurn({
          threadId,
          messageId: MessageId.make("steer-message"),
          steer: true,
          targetTurnId: activeTurnId,
          input: "Change direction",
          attachments: [attachment],
          resolvedAttachments: [attachment],
          modelSelection,
        });
        yield* Fiber.interrupt(eventsFiber);

        assert.equal(result.turnId, activeTurnId);
        assert.deepStrictEqual(runtimeEvents, []);
        assert.equal(uploadCalls.length, 1);
        assert.deepStrictEqual(
          commandCalls.map(({ id, method, params }) => ({ id, method, params })),
          [
            {
              id: "steer-message",
              method: "user_message",
              params: {
                content: "Change direction",
                artifact_ids: ["artifact-steer"],
                steer: true,
              },
            },
          ],
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer));
  });

  it.effect("does not create a replacement Task for an orphaned run cursor", () => {
    let createCalls = 0;
    const unused = () => Effect.die(new Error("Unexpected PostHog client call"));
    const posthog = PostHogCloudClient.of({
      listModels: unused,
      createTask: () =>
        Effect.sync(() => {
          createCalls += 1;
          return cloudTask(null);
        }),
      runTask: unused,
      getRun: unused,
      commandRun: unused,
      cancelRun: unused,
      uploadRunArtifacts: unused,
      readRunLogs: unused,
      streamRun: unused,
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make("orphaned-cloud-thread");
        const modelSelection = {
          instanceId: ProviderInstanceId.make("posthogCloud"),
          model: "claude:claude-sonnet-4-5",
        };
        const adapter = yield* makePostHogCloudAdapter({
          instanceId: modelSelection.instanceId,
          posthog,
          fileSystem: FileSystem.makeNoop({}),
        });
        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("posthogCloud"),
          runtimeMode: "full-access",
          modelSelection,
          resumeCursor: { schemaVersion: 1, runId: runOneId },
        });

        const error = yield* Effect.flip(
          adapter.sendTurn({
            threadId,
            input: "Retry this run",
            attachments: [],
            modelSelection,
          }),
        );

        assert.equal(error._tag, "ProviderAdapterRequestError");
        if (error._tag === "ProviderAdapterRequestError") {
          assert.equal(error.method, "resume-task");
        }
        assert.equal(createCalls, 0);
      }),
    ).pipe(Effect.provide(NodeServices.layer));
  });

  it.effect("starts a fresh run on the same Task when the persisted run no longer exists", () => {
    const runCalls: Array<Parameters<PostHogCloudClient["Service"]["runTask"]>[0]> = [];
    const unused = () => Effect.die(new Error("Unexpected PostHog client call"));
    const posthog = PostHogCloudClient.of({
      listModels: unused,
      createTask: unused,
      runTask: (input) =>
        Effect.sync(() => {
          runCalls.push(input);
          return cloudTask(cloudRun(runTwoId, "in_progress"));
        }),
      getRun: () =>
        Effect.fail(
          new PostHogRequestError({
            message: "PostHog answered 404 for the missing run.",
            status: 404,
          }),
        ),
      commandRun: unused,
      cancelRun: unused,
      uploadRunArtifacts: unused,
      readRunLogs: () => Effect.succeed(""),
      streamRun: () => Effect.succeed(Stream.never),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make("missing-run-cloud-thread");
        const modelSelection = {
          instanceId: ProviderInstanceId.make("posthogCloud"),
          model: "claude:claude-sonnet-4-5",
        };
        const adapter = yield* makePostHogCloudAdapter({
          instanceId: modelSelection.instanceId,
          posthog,
          fileSystem: FileSystem.makeNoop({}),
        });
        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("posthogCloud"),
          runtimeMode: "full-access",
          modelSelection,
          runtimePayload: { schemaVersion: 1, taskId },
          resumeCursor: { schemaVersion: 1, runId: runOneId },
        });

        yield* adapter.sendTurn({
          threadId,
          input: "Continue on a fresh run",
          attachments: [],
          modelSelection,
        });

        assert.equal(runCalls.length, 1);
        assert.equal(runCalls[0]?.taskId, taskId);
        assert.equal(runCalls[0]?.resumeFromRunId, undefined);
      }),
    ).pipe(Effect.provide(NodeServices.layer));
  });

  it.effect("surfaces an authoritative steer decline", () => {
    const unused = () => Effect.die(new Error("Unexpected PostHog client call"));
    const posthog = PostHogCloudClient.of({
      listModels: unused,
      createTask: unused,
      runTask: unused,
      getRun: () => Effect.succeed(cloudRun(runOneId, "in_progress")),
      commandRun: () =>
        Effect.succeed({ result: { stopReason: "steer_declined", steered: false } }),
      cancelRun: unused,
      uploadRunArtifacts: unused,
      readRunLogs: () => Effect.succeed(""),
      streamRun: () => Effect.succeed(Stream.never),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const activeTurnId = TurnId.make("declined-steer-turn");
        const threadId = ThreadId.make("declined-steer-thread");
        const modelSelection = {
          instanceId: ProviderInstanceId.make("posthogCloud"),
          model: "claude:claude-sonnet-4-5",
        };
        const adapter = yield* makePostHogCloudAdapter({
          instanceId: modelSelection.instanceId,
          posthog,
          fileSystem: FileSystem.makeNoop({}),
        });
        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("posthogCloud"),
          runtimeMode: "full-access",
          modelSelection,
          runtimePayload: { schemaVersion: 1, taskId, activeTurnId },
          resumeCursor: { schemaVersion: 1, runId: runOneId },
        });

        const error = yield* Effect.flip(
          adapter.sendTurn({
            threadId,
            messageId: MessageId.make("declined-steer-message"),
            steer: true,
            targetTurnId: activeTurnId,
            input: "Change direction",
            attachments: [],
            modelSelection,
          }),
        );

        assert.equal(error._tag, "ProviderAdapterRequestError");
        if (error._tag === "ProviderAdapterRequestError") {
          assert.equal(error.method, "steer-message");
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer));
  });

  it.effect("does not replay a live frame again during authoritative log reconciliation", () => {
    const frame = {
      id: "live-event-1",
      event: "message",
      data: {
        type: "notification",
        notification: {
          method: "session/update",
          params: {
            update: { sessionUpdate: "agent_message_chunk", content: { text: "hello" } },
          },
        },
      },
    } as const;
    let logCalls = 0;
    let currentRun = cloudRun(runOneId, "in_progress");

    return Effect.scoped(
      Effect.gen(function* () {
        const frames = yield* Queue.unbounded<typeof frame>();
        const posthog = PostHogCloudClient.of({
          listModels: () => Effect.die(new Error("Unexpected PostHog client call")),
          createTask: () => Effect.die(new Error("Unexpected PostHog client call")),
          runTask: () => Effect.die(new Error("Unexpected PostHog client call")),
          getRun: () => Effect.succeed(currentRun),
          commandRun: () => Effect.die(new Error("Unexpected PostHog client call")),
          cancelRun: () => Effect.die(new Error("Unexpected PostHog client call")),
          uploadRunArtifacts: () => Effect.die(new Error("Unexpected PostHog client call")),
          readRunLogs: () =>
            Effect.sync(() => {
              logCalls += 1;
              if (logCalls === 1) return "";
              currentRun = cloudRun(runOneId, "completed");
              return '{"type":"notification","notification":{"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"text":"hello"}}}}}';
            }),
          streamRun: () => Effect.succeed(Stream.fromQueue(frames).pipe(Stream.take(1))),
        });
        const adapter = yield* makePostHogCloudAdapter({
          instanceId: ProviderInstanceId.make("posthogCloud"),
          posthog,
          fileSystem: FileSystem.makeNoop({}),
        });
        const events: ProviderRuntimeEvent[] = [];
        const completed = yield* Deferred.make<void>();
        yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => events.push(event)).pipe(
              Effect.andThen(
                event.type === "turn.completed"
                  ? Deferred.succeed(completed, undefined)
                  : Effect.void,
              ),
            ),
          ),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* adapter.startSession({
          threadId: ThreadId.make("reconcile-live-frame-thread"),
          provider: ProviderDriverKind.make("posthogCloud"),
          runtimeMode: "full-access",
          runtimePayload: {
            schemaVersion: 1,
            taskId,
            activeTurnId: TurnId.make("reconcile-live-frame-turn"),
          },
          resumeCursor: { schemaVersion: 1, runId: runOneId },
        });
        yield* Queue.offer(frames, frame);
        yield* Deferred.await(completed);

        assert.equal(events.filter((event) => event.type === "content.delta").length, 1);
        assert.equal(logCalls, 2);
      }),
    ).pipe(Effect.provide(NodeServices.layer));
  });

  it.effect("deduplicates history and buffered SSE envelopes for the same notification", () => {
    const userUpdate = {
      sessionUpdate: "user_message_chunk",
      content: { text: "one prompt" },
      _meta: { importedUserPrompt: true },
    } as const;
    const assistantUpdate = {
      sessionUpdate: "agent_message_chunk",
      content: { text: "one copy" },
    } as const;
    const posthog = PostHogCloudClient.of({
      listModels: () => Effect.die(new Error("Unexpected PostHog client call")),
      createTask: () => Effect.die(new Error("Unexpected PostHog client call")),
      runTask: () => Effect.die(new Error("Unexpected PostHog client call")),
      getRun: () => Effect.succeed(cloudRun(runOneId, "completed")),
      commandRun: () => Effect.die(new Error("Unexpected PostHog client call")),
      cancelRun: () => Effect.die(new Error("Unexpected PostHog client call")),
      uploadRunArtifacts: () => Effect.die(new Error("Unexpected PostHog client call")),
      readRunLogs: () =>
        Effect.gen(function* () {
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          return [
            '{"message":{"params":{"update":{"_meta":{"importedUserPrompt":true},"content":{"text":"one prompt"},"sessionUpdate":"user_message_chunk"}},"method":"session/update"},"timestamp":"2026-08-27T12:00:00.001Z"}',
            '{"message":{"params":{"update":{"content":{"text":"one copy"},"sessionUpdate":"agent_message_chunk"}},"method":"session/update"},"timestamp":"2026-08-27T12:00:00.002Z"}',
          ].join("\n");
        }),
      streamRun: () =>
        Effect.succeed(
          Stream.make(
            {
              id: "buffered-event-1",
              event: "message",
              data: {
                notification: { method: "session/update", params: { update: userUpdate } },
                timestamp: "2026-08-27T12:00:00.003Z",
              },
            },
            {
              id: "buffered-event-2",
              event: "message",
              data: {
                notification: { method: "session/update", params: { update: assistantUpdate } },
                timestamp: "2026-08-27T12:00:00.004Z",
              },
            },
          ),
        ),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* makePostHogCloudAdapter({
          instanceId: ProviderInstanceId.make("posthogCloud"),
          posthog,
          fileSystem: FileSystem.makeNoop({}),
        });
        const events: ProviderRuntimeEvent[] = [];
        const completed = yield* Deferred.make<void>();
        yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => events.push(event)).pipe(
              Effect.andThen(
                event.type === "turn.completed"
                  ? Deferred.succeed(completed, undefined)
                  : Effect.void,
              ),
            ),
          ),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* adapter.startSession({
          threadId: ThreadId.make("hydration-dedup-thread"),
          provider: ProviderDriverKind.make("posthogCloud"),
          runtimeMode: "full-access",
          runtimePayload: {
            schemaVersion: 1,
            taskId,
            activeTurnId: TurnId.make("hydration-dedup-turn"),
          },
          resumeCursor: { schemaVersion: 1, runId: runOneId },
        });
        yield* Deferred.await(completed);

        assert.equal(events.filter((event) => event.type === "content.delta").length, 1);
        assert.equal(
          events.filter(
            (event) => event.type === "item.completed" && event.payload.itemType === "user_message",
          ).length,
          1,
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer));
  });

  it.effect("does not advance the durable log cursor past a malformed tail", () => {
    const validEntry =
      '{"type":"notification","notification":{"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"text":"safe"}}}}}';
    const unused = () => Effect.die(new Error("Unexpected PostHog client call"));
    const posthog = PostHogCloudClient.of({
      listModels: unused,
      createTask: unused,
      runTask: unused,
      getRun: () => Effect.succeed(cloudRun(runOneId, "in_progress")),
      commandRun: unused,
      cancelRun: unused,
      uploadRunArtifacts: unused,
      readRunLogs: () => Effect.succeed(`${validEntry}\n{"type":"notification"`),
      streamRun: () => Effect.succeed(Stream.never),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* makePostHogCloudAdapter({
          instanceId: ProviderInstanceId.make("posthogCloud"),
          posthog,
          fileSystem: FileSystem.makeNoop({}),
        });
        const threadId = ThreadId.make("malformed-tail-thread");
        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("posthogCloud"),
          runtimeMode: "full-access",
          runtimePayload: { schemaVersion: 1, taskId },
          resumeCursor: { schemaVersion: 1, runId: runOneId },
        });

        const sessions = yield* adapter.listSessions();
        assert.deepStrictEqual(sessions[0]?.resumeCursor, {
          schemaVersion: 1,
          runId: runOneId,
          processedEntryCount: 1,
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer));
  });
});
