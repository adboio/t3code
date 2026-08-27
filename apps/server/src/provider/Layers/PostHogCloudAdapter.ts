import {
  ApprovalRequestId,
  PostHogCloudResumeCursor,
  PostHogCloudRunId,
  PostHogCloudRuntimePayload,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  RuntimeTaskId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
  type ProviderUserInputAnswers,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { PostHogCloudClient } from "../../posthog/PostHogCloudClient.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  githubPullRequestReference,
  mapPostHogCloudProtocolEntry,
} from "./PostHogCloudProtocol.ts";
import { PostHogCloudRunSession } from "./PostHogCloudRunSession.ts";

const PROVIDER = ProviderDriverKind.make("posthogCloud");
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const CLOUD_SETUP_TASK_ID = RuntimeTaskId.make("posthog-cloud-setup");
const CLOUD_SETUP_TASK_TYPE = "provider_setup";
const decodeRuntimePayload = Schema.decodeUnknownOption(PostHogCloudRuntimePayload);
const decodeResumeCursor = Schema.decodeUnknownOption(PostHogCloudResumeCursor);

function normalizedUserInputAnswers(answers: ProviderUserInputAnswers): Record<string, string> {
  return Object.fromEntries(
    Object.entries(answers).flatMap(([question, answer]) => {
      if (typeof answer === "string") return [[question, answer]];
      if (Array.isArray(answer)) {
        return [[question, answer.filter((value) => typeof value === "string").join(", ")]];
      }
      const answerRecord = record(answer);
      if (Array.isArray(answerRecord?.answers)) {
        return [
          [question, answerRecord.answers.filter((value) => typeof value === "string").join(", ")],
        ];
      }
      return [];
    }),
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function cloudModel(
  model: string,
): { runtimeAdapter: "claude" | "codex"; model: string } | undefined {
  const separator = model.indexOf(":");
  if (separator <= 0) return undefined;
  const runtimeAdapter = model.slice(0, separator);
  const rawModel = model.slice(separator + 1);
  if ((runtimeAdapter !== "claude" && runtimeAdapter !== "codex") || rawModel.length === 0) {
    return undefined;
  }
  return { runtimeAdapter, model: rawModel };
}

function permissionDecisionKind(decision: ProviderApprovalDecision): string {
  switch (decision) {
    case "acceptForSession":
    case "acceptAlways":
      return "allow_always";
    case "accept":
      return "allow_once";
    case "decline":
    case "cancel":
      return "reject_once";
  }
}

function parseJsonLines(text: string): {
  readonly entries: ReadonlyArray<{ readonly position: number; readonly value: unknown }>;
  readonly totalEntryCount: number;
  readonly parseFailurePositions: ReadonlyArray<number>;
} {
  const entries: Array<{ readonly position: number; readonly value: unknown }> = [];
  let totalEntryCount = 0;
  const parseFailurePositions: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const position = totalEntryCount;
    totalEntryCount += 1;
    try {
      entries.push({ position, value: JSON.parse(line) });
    } catch {
      parseFailurePositions.push(position);
    }
  }
  return { entries, totalEntryCount, parseFailurePositions };
}

function fingerprint(value: unknown): string {
  try {
    return JSON.stringify(canonicalFingerprintValue(value, true));
  } catch {
    return String(value);
  }
}

function canonicalFingerprintValue(value: unknown, omitEnvelopeTimestamp = false): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalFingerprintValue(entry));
  const candidate = record(value);
  if (!candidate) return value;
  const notification = omitEnvelopeTimestamp
    ? (record(candidate.notification) ?? record(candidate.message))
    : undefined;
  if (notification && typeof notification.method === "string") {
    return {
      notification: canonicalFingerprintValue(notification),
    };
  }
  return Object.fromEntries(
    Object.entries(candidate)
      .filter(([key]) => !omitEnvelopeTimestamp || key !== "timestamp")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalFingerprintValue(entry)]),
  );
}

function commandResultPayload(result: {
  readonly response?: unknown;
  readonly result?: unknown;
}): Record<string, unknown> | undefined {
  const directResult = record(result.result);
  if (directResult) return directResult;
  const response = record(result.response);
  return record(response?.result) ?? response;
}

export interface PostHogCloudAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly posthog: PostHogCloudClient["Service"];
  readonly fileSystem: FileSystem.FileSystem;
}

export const makePostHogCloudAdapter = Effect.fn("makePostHogCloudAdapter")(function* (
  options: PostHogCloudAdapterOptions,
) {
  const crypto = yield* Crypto.Crypto;
  const posthog = options.posthog;
  const fileSystem = options.fileSystem;
  const scope = yield* Scope.Scope;
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, PostHogCloudRunSession>();
  const ingestLock = yield* Semaphore.make(1);

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const nextUuid = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Failed to create a Cloud Task runtime identifier.",
          cause,
        }),
    ),
  );

  const adapterError = (method: string) => (cause: unknown) =>
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method,
      detail: cause instanceof Error ? cause.message : String(cause),
      cause,
    });

  const publish = (event: ProviderRuntimeEvent) =>
    PubSub.publish(events, event).pipe(Effect.asVoid);

  const requireSession = (threadId: ThreadId) => {
    const context = sessions.get(threadId);
    return context
      ? Effect.succeed(context)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  const eventBase = Effect.fn("PostHogCloudAdapter.eventBase")(function* (
    context: PostHogCloudRunSession,
    source: unknown,
    timestamp?: string,
  ) {
    const eventId = context.nextEventId();
    return {
      eventId,
      provider: PROVIDER,
      providerInstanceId: options.instanceId,
      threadId: context.session.threadId,
      createdAt: timestamp ?? (yield* nowIso),
      ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
      raw: {
        source: "acp.posthog-cloud.extension" as const,
        payload: source,
      },
    };
  });

  const mapEntry = (context: PostHogCloudRunSession, entry: unknown) =>
    mapPostHogCloudProtocolEntry(context, entry, (source, timestamp) =>
      eventBase(context, source, timestamp).pipe(Effect.orDie),
    );

  const ingestEntry = (context: PostHogCloudRunSession, entry: unknown, identity: string) =>
    ingestLock.withPermits(1)(
      Effect.gen(function* () {
        if (!context.remember(identity)) return false;
        const mapped = yield* mapEntry(context, entry);
        yield* Effect.forEach(mapped, publish, { discard: true });
        return true;
      }),
    );

  const completeRun = Effect.fn("PostHogCloudAdapter.completeRun")(function* (
    context: PostHogCloudRunSession,
  ) {
    if (!context.taskId || !context.runId) return true;
    const run = yield* posthog
      .getRun({ taskId: context.taskId, runId: context.runId })
      .pipe(Effect.mapError(adapterError("get-run")));
    if (!TERMINAL_STATUSES.has(run.status)) return false;
    const createdAt = yield* nowIso;
    const activeTurnId = context.activeTurnId;
    const state = run.status === "failed" ? "error" : "ready";
    context.activeTurnId = undefined;
    context.backgroundTurnId = undefined;
    context.sync({
      status: state,
      activeTurnId: undefined,
      updatedAt: createdAt,
      ...(run.error_message ? { lastError: run.error_message } : {}),
    });
    const output = record(run.output);
    const runState = record(run.state);
    const repository =
      typeof runState?.repository === "string" ? runState.repository : context.repository;
    const prUrl = typeof output?.pr_url === "string" ? output.pr_url : undefined;
    const pullRequest = githubPullRequestReference(prUrl, repository);
    if (run.branch || pullRequest) {
      yield* publish({
        ...(yield* eventBase(context, run, createdAt).pipe(Effect.orDie)),
        type: "thread.metadata.updated",
        payload: {
          ...(run.branch ? { branch: run.branch } : {}),
          ...(pullRequest ? { pullRequest } : {}),
        },
      });
    }
    if (run.status === "failed") {
      yield* publish({
        ...(yield* eventBase(context, run, createdAt).pipe(Effect.orDie)),
        type: "runtime.error",
        payload: {
          message: run.error_message ?? "The Cloud Task failed.",
          class: "provider_error",
          detail: run,
        },
      });
    }
    if (activeTurnId) {
      const base = yield* eventBase(context, run, createdAt).pipe(Effect.orDie);
      yield* publish(
        run.status === "completed"
          ? {
              ...base,
              type: "turn.completed",
              turnId: activeTurnId,
              payload: { state: "completed", stopReason: null },
            }
          : {
              ...base,
              type: "turn.aborted",
              turnId: activeTurnId,
              payload: { reason: run.status === "cancelled" ? "run_cancelled" : "run_failed" },
            },
      );
    }
    return true;
  });

  const watchRun = Effect.fn("PostHogCloudAdapter.watchRun")(function* (
    context: PostHogCloudRunSession,
    runId: PostHogCloudRunId,
    includeHistory: boolean,
  ) {
    if (!context.taskId || context.watcherRunId === runId) return;
    if (context.watcher) yield* Fiber.interrupt(context.watcher);
    context.watcherRunId = runId;
    const taskId = context.taskId;
    const buffered = yield* Ref.make<{
      hydrating: boolean;
      frames: ReadonlyArray<{ readonly data: unknown; readonly id?: string }>;
    }>({
      hydrating: includeHistory,
      frames: [],
    });
    let anonymousStreamSequence = 0;
    let streamAttempt = 0;
    let stalledMalformedPosition: number | undefined;
    let stalledMalformedPasses = 0;
    const pendingStreamFingerprints: string[] = [];

    const ingestFrame = (frame: { readonly data: unknown; readonly id?: string }) => {
      const frameId = frame.id;
      return (
        frameId ? Effect.sync(() => context.advanceCursor({ lastEventId: frameId })) : Effect.void
      ).pipe(
        Effect.andThen(
          ingestEntry(
            context,
            frame.data,
            frameId ? `sse:${runId}:${frameId}` : `stream:${runId}:${++anonymousStreamSequence}`,
          ).pipe(
            Effect.tap((ingested) =>
              ingested
                ? Effect.sync(() => {
                    pendingStreamFingerprints.push(fingerprint(frame.data));
                  })
                : Effect.void,
            ),
          ),
        ),
      );
    };

    const reconcileLogs = Effect.fn("PostHogCloudAdapter.reconcileLogs")(function* () {
      const logs = yield* posthog
        .readRunLogs({ taskId, runId })
        .pipe(Effect.mapError(adapterError("read-run-logs")));
      const parsed = parseJsonLines(logs);
      const startPosition = Math.min(context.processedEntryCount, parsed.totalEntryCount);
      const malformedPosition = parsed.parseFailurePositions.find(
        (position) => position >= startPosition,
      );
      if (malformedPosition === undefined) {
        stalledMalformedPosition = undefined;
        stalledMalformedPasses = 0;
      } else if (stalledMalformedPosition === malformedPosition) {
        stalledMalformedPasses += 1;
      } else {
        stalledMalformedPosition = malformedPosition;
        stalledMalformedPasses = 1;
      }
      const skipMalformedTail = malformedPosition !== undefined && stalledMalformedPasses < 3;
      const endPosition = skipMalformedTail ? malformedPosition : parsed.totalEntryCount;
      const tailEntries = parsed.entries.filter(
        (entry) => entry.position >= startPosition && entry.position < endPosition,
      );
      const ingestedFingerprints = new Map<string, number>();
      yield* Effect.forEach(
        tailEntries,
        (entry) => {
          const key = fingerprint(entry.value);
          context.advanceCursor({ processedEntryCount: entry.position + 1 });
          if (pendingStreamFingerprints[0] === key) {
            pendingStreamFingerprints.shift();
            return Effect.void;
          }
          return ingestEntry(context, entry.value, `log:${runId}:${entry.position}`).pipe(
            Effect.tap((ingested) =>
              ingested
                ? Effect.sync(() => {
                    ingestedFingerprints.set(key, (ingestedFingerprints.get(key) ?? 0) + 1);
                  })
                : Effect.void,
            ),
          );
        },
        { discard: true },
      );
      context.advanceCursor({ processedEntryCount: endPosition });
      if (parsed.parseFailurePositions.length > 0) {
        yield* Effect.logWarning("PostHog Cloud Task log contained malformed entries", {
          taskId,
          runId,
          parseFailureCount: parsed.parseFailurePositions.length,
          ...(malformedPosition !== undefined
            ? { malformedPosition, stalledPasses: stalledMalformedPasses }
            : {}),
          skippedTail: skipMalformedTail,
        });
      }
      return ingestedFingerprints;
    });

    const consume = Effect.gen(function* () {
      while (context.watcherRunId === runId) {
        const cursor = record(context.session.resumeCursor);
        const startLatest =
          cursor?.lastEventId === undefined &&
          context.processedEntryCount > 0 &&
          (!includeHistory || streamAttempt > 0);
        streamAttempt += 1;
        const streamResult = yield* posthog
          .streamRun({
            taskId,
            runId,
            ...(typeof cursor?.lastEventId === "string" ? { lastEventId: cursor.lastEventId } : {}),
            ...(startLatest ? { startLatest: true } : {}),
          })
          .pipe(Effect.mapError(adapterError("stream-run")), Effect.result);
        if (streamResult._tag === "Failure") {
          yield* Effect.logWarning("PostHog Cloud Task stream could not open", {
            cause: streamResult.failure,
          });
          if (yield* completeRun(context).pipe(Effect.orElseSucceed(() => false))) return;
          yield* Effect.sleep("1 second");
          continue;
        }
        const stream = streamResult.success;
        yield* stream.pipe(
          Stream.runForEach((frame) => {
            if (frame.event === "keepalive") return Effect.void;
            if (frame.event === "stream-end") return Effect.void;
            return Ref.modify(buffered, (state) =>
              state.hydrating
                ? [
                    Effect.void,
                    {
                      ...state,
                      frames: [
                        ...state.frames,
                        { data: frame.data, ...(frame.id ? { id: frame.id } : {}) },
                      ],
                    },
                  ]
                : [ingestFrame({ data: frame.data, ...(frame.id ? { id: frame.id } : {}) }), state],
            ).pipe(Effect.flatten);
          }),
          Effect.catchCause((cause) =>
            Effect.logWarning("PostHog Cloud Task stream disconnected", { cause }),
          ),
        );
        const hydrationState = yield* Ref.get(buffered);
        if (!hydrationState.hydrating) {
          yield* reconcileLogs().pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("PostHog Cloud Task log reconciliation failed", { cause }),
            ),
          );
        }
        if (yield* completeRun(context).pipe(Effect.orElseSucceed(() => false))) return;
        yield* Effect.sleep("1 second");
      }
    });

    context.watcher = yield* Effect.forkIn(consume, scope);

    if (includeHistory) {
      const historyFingerprints = yield* reconcileLogs();
      const tail = yield* Ref.modify(buffered, (state) => [
        state.frames,
        { hydrating: false, frames: [] },
      ]);
      yield* Effect.forEach(
        tail,
        (frame) => {
          const key = fingerprint(frame.data);
          const duplicateCount = historyFingerprints.get(key) ?? 0;
          if (duplicateCount > 0) {
            historyFingerprints.set(key, duplicateCount - 1);
            const frameId = frame.id;
            return frameId
              ? Effect.sync(() => context.advanceCursor({ lastEventId: frameId }))
              : Effect.void;
          }
          return ingestFrame(frame);
        },
        { discard: true },
      );
    }
  });

  const startSession = Effect.fn("PostHogCloudAdapter.startSession")(function* (
    input: ProviderSessionStartInput,
  ) {
    const decodedPayload = decodeRuntimePayload(input.runtimePayload);
    const payload = Option.getOrUndefined(decodedPayload);
    const persistedPayload = record(input.runtimePayload);
    const persistedActiveTurnId =
      typeof persistedPayload?.activeTurnId === "string"
        ? TurnId.make(persistedPayload.activeTurnId)
        : undefined;
    const decodedCursor = decodeResumeCursor(input.resumeCursor);
    const cursor = Option.getOrUndefined(decodedCursor);
    const createdAt = yield* nowIso;
    const context = new PostHogCloudRunSession({
      taskId: payload?.taskId,
      runId: cursor?.runId,
      repository: input.repository ?? payload?.repository,
      reportId: input.reportId,
      activeTurnId: persistedActiveTurnId,
      session: {
        provider: PROVIDER,
        providerInstanceId: options.instanceId,
        status: persistedActiveTurnId ? "running" : "ready",
        runtimeMode: input.runtimeMode,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
        threadId: input.threadId,
        ...(persistedActiveTurnId ? { activeTurnId: persistedActiveTurnId } : {}),
        ...(cursor ? { resumeCursor: cursor } : {}),
        ...(payload ? { runtimePayload: payload } : {}),
        createdAt,
        updatedAt: createdAt,
      },
    });
    sessions.set(input.threadId, context);
    yield* publish({
      ...(yield* eventBase(context, input, createdAt).pipe(Effect.orDie)),
      type: "session.started",
      payload: { resume: cursor },
    });
    yield* publish({
      ...(yield* eventBase(context, input, createdAt).pipe(Effect.orDie)),
      type: "thread.started",
      payload: { providerThreadId: payload?.taskId },
    });
    if (context.taskId && context.runId) {
      yield* watchRun(context, context.runId, cursor?.lastEventId === undefined);
    }
    return context.session;
  });

  const uploadAttachments = Effect.fn("PostHogCloudAdapter.uploadAttachments")(function* (
    context: PostHogCloudRunSession,
    attachments: NonNullable<ProviderSendTurnInput["resolvedAttachments"]>,
  ) {
    if (!context.taskId || !context.runId || attachments.length === 0) return [];
    const payloads = yield* Effect.forEach(attachments, (attachment) =>
      fileSystem.readFile(attachment.path).pipe(
        Effect.map((bytes) => ({
          name: attachment.name,
          contentType: attachment.mimeType,
          base64: Buffer.from(bytes).toString("base64"),
        })),
        Effect.mapError(adapterError("read-attachment")),
      ),
    );
    const manifest = yield* posthog
      .uploadRunArtifacts({
        taskId: context.taskId,
        runId: context.runId,
        artifacts: payloads,
      })
      .pipe(Effect.mapError(adapterError("upload-attachments")));
    return manifest.slice(-attachments.length).map((artifact) => artifact.id);
  });

  const sendTurn = Effect.fn("PostHogCloudAdapter.sendTurn")(function* (
    input: ProviderSendTurnInput,
  ) {
    const context = yield* requireSession(input.threadId);
    const message = input.input?.trim();
    if (!message) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "Cloud Task turns require a text prompt.",
      });
    }
    const attachments = input.resolvedAttachments ?? [];
    if ((input.attachments?.length ?? 0) !== attachments.length) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "One or more Cloud Task attachments could not be read.",
      });
    }
    const selected = input.modelSelection ? cloudModel(input.modelSelection.model) : undefined;
    if (!selected) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "Select a model from the PostHog Cloud model catalogue.",
      });
    }
    if (!context.taskId) {
      if (context.runId) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "resume-task",
          detail: "The Cloud Task run cannot be resumed because its Task identity is missing.",
        });
      }
      const task = yield* posthog
        .createTask({
          title: message.slice(0, 120),
          description: attachments.length > 0 ? "" : message,
          ...(context.repository ? { repository: context.repository } : {}),
          ...(context.reportId ? { signalReportId: context.reportId } : {}),
        })
        .pipe(Effect.mapError(adapterError("create-task")));
      context.taskId = task.id;
    }
    context.registerLocalUserEcho(message);

    let currentRun = context.runId
      ? yield* posthog
          .getRun({ taskId: context.taskId, runId: context.runId })
          .pipe(
            Effect.catch((error) =>
              error._tag === "PostHogRequestError" && error.status === 404
                ? Effect.void
                : Effect.fail(adapterError("get-run")(error)),
            ),
          )
      : undefined;
    const steeringTurnId = input.steer ? (input.targetTurnId ?? context.activeTurnId) : undefined;
    if (steeringTurnId && currentRun && !TERMINAL_STATUSES.has(currentRun.status)) {
      const artifactIds = yield* uploadAttachments(context, attachments);
      const commandResult = yield* posthog
        .commandRun({
          taskId: context.taskId,
          runId: currentRun.id,
          method: "user_message",
          params: {
            content: message,
            ...(artifactIds.length > 0 ? { artifact_ids: artifactIds } : {}),
            steer: true,
          },
          id: input.messageId ?? (yield* nextUuid),
        })
        .pipe(Effect.mapError(adapterError("steer-message")));
      const outcome = commandResultPayload(commandResult);
      if (outcome?.steered === false || outcome?.stopReason === "steer_declined") {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "steer-message",
          detail: "The Cloud Task was no longer accepting steering for that turn.",
        });
      }
      return {
        threadId: input.threadId,
        turnId: steeringTurnId,
        resumeCursor: context.resumeCursor(),
      };
    }

    const turnId = TurnId.make(yield* nextUuid);
    const createdAt = yield* nowIso;
    context.beginTurn(turnId, createdAt);
    yield* publish({
      ...(yield* eventBase(context, input, createdAt).pipe(Effect.orDie)),
      type: "turn.started",
      turnId,
      payload: {
        model: selected.model,
        effort:
          getModelSelectionStringOptionValue(input.modelSelection, "reasoningEffort") ?? undefined,
      },
    });

    if (currentRun && !TERMINAL_STATUSES.has(currentRun.status) && attachments.length === 0) {
      yield* posthog
        .commandRun({
          taskId: context.taskId,
          runId: currentRun.id,
          method: "user_message",
          params: { content: message, steer: false },
          id: input.messageId ?? (yield* nextUuid),
        })
        .pipe(Effect.mapError(adapterError("send-message")));
    } else if (!currentRun || TERMINAL_STATUSES.has(currentRun.status)) {
      const task = yield* posthog
        .runTask({
          taskId: context.taskId,
          message: attachments.length > 0 ? "" : message,
          ...(currentRun ? { resumeFromRunId: currentRun.id } : {}),
          runtimeAdapter: selected.runtimeAdapter,
          model: selected.model,
          ...(getModelSelectionStringOptionValue(input.modelSelection, "reasoningEffort")
            ? {
                reasoningEffort: getModelSelectionStringOptionValue(
                  input.modelSelection,
                  "reasoningEffort",
                )!,
              }
            : {}),
        })
        .pipe(Effect.mapError(adapterError("run-task")));
      currentRun = task.latest_run ?? undefined;
      if (!currentRun) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "run-task",
          detail: "PostHog started the Task without returning its TaskRun.",
        });
      }
      context.setRunId(currentRun.id);
      context.toolItems.clear();
      yield* publish({
        ...(yield* eventBase(context, currentRun, createdAt).pipe(Effect.orDie)),
        type: "task.progress",
        payload: {
          taskId: CLOUD_SETUP_TASK_ID,
          taskType: CLOUD_SETUP_TASK_TYPE,
          description:
            currentRun.status === "queued" ? "Waiting in the queue…" : "Starting the sandbox…",
          status: "running",
        },
      });
      yield* watchRun(context, currentRun.id, true);
    }
    if (attachments.length > 0) {
      const artifactIds = yield* uploadAttachments(context, attachments);
      yield* posthog
        .commandRun({
          taskId: context.taskId,
          runId: context.runId!,
          method: "user_message",
          params: { content: message, artifact_ids: artifactIds, steer: false },
          id: input.messageId ?? (yield* nextUuid),
        })
        .pipe(Effect.mapError(adapterError("send-message")));
    }
    return { threadId: input.threadId, turnId, resumeCursor: context.resumeCursor() };
  });

  const interruptTurn = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      if (!context.taskId || !context.runId) return;
      yield* posthog
        .commandRun({
          taskId: context.taskId,
          runId: context.runId,
          method: "cancel",
          id: yield* nextUuid,
        })
        .pipe(Effect.mapError(adapterError("interrupt-turn")));
      const createdAt = yield* nowIso;
      const turnId = context.activeTurnId;
      context.finishTurn(createdAt);
      if (turnId) {
        yield* publish({
          ...(yield* eventBase(context, { method: "cancel" }, createdAt).pipe(Effect.orDie)),
          type: "turn.aborted",
          turnId,
          payload: { reason: "interrupted" },
        });
      }
    });

  const respondToRequest = (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      if (!context.taskId || !context.runId) return;
      const optionsList = context.permissions.get(requestId) ?? [];
      const wanted = permissionDecisionKind(decision);
      const selected =
        optionsList.find((option) => option.kind === wanted) ??
        optionsList.find(
          (option) => wanted.startsWith("reject") && option.kind?.startsWith("reject"),
        );
      if (!selected) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "respondToRequest",
          issue: `The Cloud Task did not offer an option for '${decision}'.`,
        });
      }
      yield* posthog
        .commandRun({
          taskId: context.taskId,
          runId: context.runId,
          method: "permission_response",
          params: { requestId, optionId: selected.optionId },
          id: yield* nextUuid,
        })
        .pipe(Effect.mapError(adapterError("permission-response")));
      context.permissions.delete(requestId);
    });

  const respondToUserInput = (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      if (!context.taskId || !context.runId) return;
      const normalizedAnswers = normalizedUserInputAnswers(answers);
      const firstAnswer = Object.values(normalizedAnswers)[0];
      const offeredOptions = context.permissions.get(requestId) ?? [];
      const optionId =
        offeredOptions.find((option) => option.name === firstAnswer)?.optionId ??
        offeredOptions[0]?.optionId;
      if (!optionId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "respondToUserInput",
          issue: `The Cloud Task did not offer an option for user input request '${requestId}'.`,
        });
      }
      yield* posthog
        .commandRun({
          taskId: context.taskId,
          runId: context.runId,
          method: "permission_response",
          params: { requestId, optionId, answers: normalizedAnswers },
          id: yield* nextUuid,
        })
        .pipe(Effect.mapError(adapterError("user-input-response")));
      context.permissions.delete(requestId);
      context.userInputRequests.delete(requestId);
      context.locallyResolvedUserInputs.add(requestId);
      const createdAt = yield* nowIso;
      yield* publish({
        ...(yield* eventBase(context, { requestId, answers: normalizedAnswers }, createdAt).pipe(
          Effect.orDie,
        )),
        type: "user-input.resolved",
        requestId: RuntimeRequestId.make(requestId),
        payload: { answers: normalizedAnswers },
      });
    });

  const disconnectSession = (context: PostHogCloudRunSession) =>
    Effect.gen(function* () {
      if (context.watcher) yield* Fiber.interrupt(context.watcher);
      context.watcher = undefined;
      context.watcherRunId = undefined;
      const updatedAt = yield* nowIso;
      context.sync({ status: "closed", activeTurnId: undefined, updatedAt });
    });

  const stopSession = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      if (context.taskId && context.runId) {
        yield* posthog
          .cancelRun({ taskId: context.taskId, runId: context.runId })
          .pipe(Effect.mapError(adapterError("stop-run")));
      }
      yield* disconnectSession(context);
    });

  const adapter: ProviderAdapterShape<
    | ProviderAdapterRequestError
    | ProviderAdapterSessionNotFoundError
    | ProviderAdapterValidationError
  > = {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "unsupported",
      attachmentMode: "upload",
      execution: "remote",
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions: () => Effect.succeed(Array.from(sessions.values(), (context) => context.session)),
    hasSession: (threadId) => Effect.succeed(sessions.has(threadId)),
    readThread: (threadId) =>
      requireSession(threadId).pipe(Effect.as({ threadId, turns: [] as const })),
    rollbackThread: (threadId) =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: `Cloud Task thread '${threadId}' cannot be rolled back locally.`,
        }),
      ),
    stopAll: () =>
      Effect.forEach(Array.from(sessions.values()), disconnectSession, { discard: true }).pipe(
        Effect.ignore,
      ),
    streamEvents: Stream.fromPubSub(events),
  };

  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      Array.from(sessions.values()),
      (context) => (context.watcher ? Fiber.interrupt(context.watcher) : Effect.void),
      { discard: true },
    ).pipe(Effect.andThen(PubSub.shutdown(events))),
  );

  return adapter;
});
