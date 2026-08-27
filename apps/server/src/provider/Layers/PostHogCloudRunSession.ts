import {
  EventId,
  PostHogCloudResumeCursor,
  type PostHogCloudRunId,
  type PostHogCloudRuntimePayload,
  type PostHogCloudTaskId,
  type ProviderSession,
  type RuntimeItemId,
  type TurnId,
} from "@t3tools/contracts";
import type * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeResumeCursor = Schema.decodeUnknownOption(PostHogCloudResumeCursor);

export interface PostHogCloudPermissionOption {
  readonly optionId: string;
  readonly kind?: string;
  readonly name?: string;
}

export interface PostHogCloudToolState {
  readonly itemId: RuntimeItemId;
  readonly update: Record<string, unknown>;
}

export class PostHogCloudRunSession {
  taskId: PostHogCloudTaskId | undefined;
  runId: PostHogCloudRunId | undefined;
  activeTurnId: TurnId | undefined;
  assistantItemId: RuntimeItemId | undefined;
  assistantText = "";
  reasoningItemId: RuntimeItemId | undefined;
  watcherRunId: PostHogCloudRunId | undefined;
  watcher: Fiber.Fiber<void> | undefined;
  session: ProviderSession;
  lastEventId: string | undefined;
  processedEntryCount: number;
  backgroundTurnId: TurnId | undefined;

  readonly repository: string | undefined;
  readonly reportId: string | undefined;
  readonly toolItems = new Map<string, PostHogCloudToolState>();
  readonly permissions = new Map<string, ReadonlyArray<PostHogCloudPermissionOption>>();
  readonly userInputRequests = new Set<string>();
  readonly locallyResolvedUserInputs = new Set<string>();
  private readonly localUserEchoes = new Map<string, number>();

  private sequence: number;
  private readonly seen = new Set<string>();

  constructor(input: {
    readonly session: ProviderSession;
    readonly taskId: PostHogCloudTaskId | undefined;
    readonly runId: PostHogCloudRunId | undefined;
    readonly repository: string | undefined;
    readonly reportId: string | undefined;
    readonly activeTurnId: TurnId | undefined;
  }) {
    this.session = input.session;
    this.taskId = input.taskId;
    this.runId = input.runId;
    this.repository = input.repository;
    this.reportId = input.reportId;
    this.activeTurnId = input.activeTurnId;
    const cursor = Option.getOrUndefined(decodeResumeCursor(input.session.resumeCursor));
    const cursorMatchesRun = cursor !== undefined && cursor.runId === input.runId;
    this.lastEventId = cursorMatchesRun ? cursor.lastEventId : undefined;
    this.processedEntryCount = cursorMatchesRun ? (cursor.processedEntryCount ?? 0) : 0;
    this.sequence = this.processedEntryCount;
    this.sync();
  }

  nextEventId(): EventId {
    this.sequence += 1;
    return EventId.make(`posthog-cloud:${this.runId ?? "pending"}:${this.sequence}`);
  }

  currentSequence(): number {
    return this.sequence;
  }

  remember(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  registerLocalUserEcho(text: string): void {
    this.localUserEchoes.set(text, (this.localUserEchoes.get(text) ?? 0) + 1);
  }

  consumeLocalUserEcho(text: string): boolean {
    const count = this.localUserEchoes.get(text) ?? 0;
    if (count === 0) return false;
    if (count === 1) this.localUserEchoes.delete(text);
    else this.localUserEchoes.set(text, count - 1);
    return true;
  }

  setRunId(runId: PostHogCloudRunId): void {
    if (this.runId !== runId) {
      this.runId = runId;
      this.lastEventId = undefined;
      this.processedEntryCount = 0;
      this.sequence = 0;
      this.seen.clear();
    }
    this.sync();
  }

  advanceCursor(input: {
    readonly lastEventId?: string;
    readonly processedEntryCount?: number;
  }): void {
    if (input.lastEventId !== undefined) this.lastEventId = input.lastEventId;
    if (input.processedEntryCount !== undefined) {
      this.processedEntryCount = Math.max(this.processedEntryCount, input.processedEntryCount);
    }
    this.sync();
  }

  runtimePayload(): PostHogCloudRuntimePayload {
    return {
      schemaVersion: 1,
      ...(this.taskId ? { taskId: this.taskId } : {}),
      ...(this.repository ? { repository: this.repository } : {}),
    };
  }

  resumeCursor(): PostHogCloudResumeCursor {
    return {
      schemaVersion: 1,
      ...(this.runId ? { runId: this.runId } : {}),
      ...(this.lastEventId ? { lastEventId: this.lastEventId } : {}),
      ...(this.processedEntryCount > 0 ? { processedEntryCount: this.processedEntryCount } : {}),
    };
  }

  sync(patch?: Partial<ProviderSession>): void {
    this.session = {
      ...this.session,
      ...patch,
    };
    this.session = {
      ...this.session,
      runtimePayload: this.runtimePayload(),
      resumeCursor: this.resumeCursor(),
    };
  }

  beginTurn(turnId: TurnId, updatedAt: string): void {
    this.activeTurnId = turnId;
    this.assistantItemId = undefined;
    this.assistantText = "";
    this.reasoningItemId = undefined;
    this.sync({ status: "running", activeTurnId: turnId, updatedAt });
  }

  finishTurn(updatedAt: string): void {
    if (this.backgroundTurnId === this.activeTurnId) this.backgroundTurnId = undefined;
    this.activeTurnId = undefined;
    this.sync({ status: "ready", activeTurnId: undefined, updatedAt });
  }
}
