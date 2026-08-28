import {
  ForwardCompatibleArray,
  PostHogCloudCommandResult,
  PostHogCloudModel,
  PostHogGatewayModel,
  type PostHogCloudPermissionMode,
  PostHogCloudRun,
  PostHogCloudRunArtifact,
  type PostHogCloudRunId,
  type PostHogCloudStreamEvent,
  PostHogCloudTask,
  type PostHogCloudTaskId,
  PostHogRequestError,
  type PostHogRpcError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClientRequest } from "effect/unstable/http";

import { decodePostHogSse } from "./PostHogSse.ts";
import { PostHogTransport } from "./PostHogTransport.ts";

const CloudModelsBody = Schema.Struct({ models: Schema.Array(PostHogCloudModel) });
// The gateway answers OpenAI-style `{ data: [...] }`. Unknown entries are
// dropped rather than failing the list: one malformed model must not cost the
// catalogue.
const GatewayModelsBody = Schema.Struct({
  data: ForwardCompatibleArray(PostHogGatewayModel),
});
const CloudArtifactsBody = Schema.Struct({ artifacts: Schema.Array(PostHogCloudRunArtifact) });
const decodeCloudModels = Schema.decodeUnknownEffect(CloudModelsBody);
const decodeGatewayModels = Schema.decodeUnknownEffect(GatewayModelsBody);
const decodeCloudTask = Schema.decodeUnknownEffect(PostHogCloudTask);
const decodeCloudRun = Schema.decodeUnknownEffect(PostHogCloudRun);
const decodeCloudCommandResult = Schema.decodeUnknownEffect(PostHogCloudCommandResult);
const decodeCloudArtifacts = Schema.decodeUnknownEffect(CloudArtifactsBody);

interface CreateCloudTaskInput {
  readonly title: string;
  readonly description: string;
  readonly repository?: string;
  readonly signalReportId?: string;
}

interface RunCloudTaskInput {
  readonly taskId: PostHogCloudTaskId;
  readonly message: string;
  readonly resumeFromRunId?: PostHogCloudRunId;
  readonly runtimeAdapter: "claude" | "codex";
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly initialPermissionMode?: PostHogCloudPermissionMode;
  readonly artifactIds?: ReadonlyArray<string>;
}

interface CloudRunInput {
  readonly taskId: PostHogCloudTaskId;
  readonly runId: PostHogCloudRunId;
}

interface CloudCommandInput extends CloudRunInput {
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly id?: string;
}

interface CloudArtifactUploadInput extends CloudRunInput {
  readonly artifacts: ReadonlyArray<{
    readonly name: string;
    readonly contentType: string;
    readonly base64: string;
  }>;
}

interface CloudStreamInput extends CloudRunInput {
  readonly lastEventId?: string;
  readonly startLatest?: boolean;
}

export class PostHogCloudClient extends Context.Service<
  PostHogCloudClient,
  {
    readonly listModels: () => Effect.Effect<ReadonlyArray<PostHogCloudModel>, PostHogRpcError>;
    /**
     * The gateway's raw catalogue, which is wider than `listModels`: it also
     * carries the models PostHog serves through the Claude harness under a
     * provider the task API has no runtime adapter for.
     */
    readonly listGatewayModels: () => Effect.Effect<
      ReadonlyArray<PostHogGatewayModel>,
      PostHogRpcError
    >;
    readonly createTask: (
      input: CreateCloudTaskInput,
    ) => Effect.Effect<PostHogCloudTask, PostHogRpcError>;
    readonly runTask: (
      input: RunCloudTaskInput,
    ) => Effect.Effect<PostHogCloudTask, PostHogRpcError>;
    readonly getRun: (input: CloudRunInput) => Effect.Effect<PostHogCloudRun, PostHogRpcError>;
    readonly commandRun: (
      input: CloudCommandInput,
    ) => Effect.Effect<PostHogCloudCommandResult, PostHogRpcError>;
    readonly cancelRun: (input: CloudRunInput) => Effect.Effect<PostHogCloudRun, PostHogRpcError>;
    readonly uploadRunArtifacts: (
      input: CloudArtifactUploadInput,
    ) => Effect.Effect<ReadonlyArray<PostHogCloudRunArtifact>, PostHogRpcError>;
    readonly readRunLogs: (input: CloudRunInput) => Effect.Effect<string, PostHogRpcError>;
    readonly streamRun: (
      input: CloudStreamInput,
    ) => Effect.Effect<Stream.Stream<PostHogCloudStreamEvent, PostHogRpcError>, PostHogRpcError>;
  }
>()("t3/posthog/PostHogCloudClient") {}

const runPath = (input: CloudRunInput, suffix = "") =>
  `/tasks/${encodeURIComponent(input.taskId)}/runs/${encodeURIComponent(input.runId)}/${suffix}`;

export const layer = Layer.effect(
  PostHogCloudClient,
  Effect.gen(function* () {
    const transport = yield* PostHogTransport;

    /**
     * The LLM gateway that serves this PostHog host.
     *
     * Mirrors `getCloudTaskGatewayUrl` in the PostHog monorepo
     * (`products/desktop/packages/shared/src/cloud-task-models.ts`): the
     * gateway lives on its own hostname per region, under the same
     * `posthog_code` product a task run authenticates as.
     */
    const gatewayUrl = (host: string): string => {
      const url = new URL(host);
      if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
        return `${url.protocol}//localhost:3308/posthog_code`;
      }
      if (url.hostname === "host.docker.internal") {
        return `${url.protocol}//host.docker.internal:3308/posthog_code`;
      }
      if (url.hostname === "app.dev.posthog.dev") {
        return "https://gateway.dev.posthog.dev/posthog_code";
      }
      const region = /^(us|eu)\.posthog\.com$/.exec(url.hostname)?.[1] ?? "us";
      return `https://gateway.${region}.posthog.com/posthog_code`;
    };

    const listGatewayModels: PostHogCloudClient["Service"]["listGatewayModels"] = Effect.fn(
      "PostHogCloudClient.listGatewayModels",
    )(function* () {
      const connection = yield* transport.connection;
      const response = yield* transport.execute(
        connection,
        HttpClientRequest.get(`${gatewayUrl(connection.host)}/v1/models`).pipe(
          HttpClientRequest.setHeader("x-posthog-project-id", connection.projectId),
        ),
        "for the model gateway",
      );
      const body = yield* response.json.pipe(
        Effect.mapError(
          (cause) =>
            new PostHogRequestError({
              message: "The model gateway returned an unreadable body.",
              cause,
            }),
        ),
      );
      const decoded = yield* decodeGatewayModels(body).pipe(
        Effect.mapError(
          (cause) =>
            new PostHogRequestError({
              message: "The model gateway returned an unexpected catalogue.",
              cause,
            }),
        ),
      );
      return decoded.data;
    });

    const listModels: PostHogCloudClient["Service"]["listModels"] = Effect.fn(
      "PostHogCloudClient.listModels",
    )(function* () {
      const connection = yield* transport.connection;
      const body = yield* transport.getJson(connection, "/tasks/models/", {});
      const decoded = yield* decodeCloudModels(body).pipe(
        Effect.mapError(
          (cause) =>
            new PostHogRequestError({
              message: "PostHog returned an unexpected model catalogue.",
              cause,
            }),
        ),
      );
      return decoded.models;
    });

    const createTask: PostHogCloudClient["Service"]["createTask"] = Effect.fn(
      "PostHogCloudClient.createTask",
    )(function* (input) {
      const connection = yield* transport.connection;
      const body = yield* transport.sendJson(connection, "post", "/tasks/", {
        title: input.title,
        description: input.description,
        origin_product: input.signalReportId ? "signal_report" : "user_created",
        ...(input.repository ? { repository: input.repository } : {}),
        ...(input.signalReportId
          ? { signal_report: input.signalReportId, signal_report_task_relationship: "discussion" }
          : {}),
      });
      return yield* decodeCloudTask(body).pipe(
        Effect.mapError(
          (cause) =>
            new PostHogRequestError({ message: "PostHog returned an unexpected Task.", cause }),
        ),
      );
    });

    const runTask: PostHogCloudClient["Service"]["runTask"] = Effect.fn(
      "PostHogCloudClient.runTask",
    )(function* (input) {
      const connection = yield* transport.connection;
      const body = yield* transport.sendJson(
        connection,
        "post",
        `/tasks/${encodeURIComponent(input.taskId)}/run/`,
        {
          mode: "interactive",
          pending_user_message: input.message,
          runtime_adapter: input.runtimeAdapter,
          model: input.model,
          auto_publish: false,
          ...(input.resumeFromRunId ? { resume_from_run_id: input.resumeFromRunId } : {}),
          ...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {}),
          ...(input.initialPermissionMode
            ? { initial_permission_mode: input.initialPermissionMode }
            : {}),
          ...(input.artifactIds?.length ? { pending_user_artifact_ids: input.artifactIds } : {}),
        },
      );
      return yield* decodeCloudTask(body).pipe(
        Effect.mapError(
          (cause) =>
            new PostHogRequestError({ message: "PostHog returned an unexpected Task run.", cause }),
        ),
      );
    });

    const getRun: PostHogCloudClient["Service"]["getRun"] = Effect.fn("PostHogCloudClient.getRun")(
      function* (input) {
        const connection = yield* transport.connection;
        const body = yield* transport.getJson(connection, runPath(input), {});
        return yield* decodeCloudRun(body).pipe(
          Effect.mapError(
            (cause) =>
              new PostHogRequestError({
                message: "PostHog returned an unexpected TaskRun.",
                cause,
              }),
          ),
        );
      },
    );

    const commandRun: PostHogCloudClient["Service"]["commandRun"] = Effect.fn(
      "PostHogCloudClient.commandRun",
    )(function* (input) {
      const connection = yield* transport.connection;
      const body = yield* transport.sendJson(connection, "post", runPath(input, "command/"), {
        jsonrpc: "2.0",
        method: input.method,
        params: input.params ?? {},
        ...(input.id ? { id: input.id } : {}),
      });
      return yield* decodeCloudCommandResult(body).pipe(
        Effect.orElseSucceed(() => ({ response: body })),
      );
    });

    const cancelRun: PostHogCloudClient["Service"]["cancelRun"] = Effect.fn(
      "PostHogCloudClient.cancelRun",
    )(function* (input) {
      const connection = yield* transport.connection;
      const body = yield* transport.sendJson(connection, "post", runPath(input, "cancel/"), {});
      return yield* decodeCloudRun(body).pipe(
        Effect.mapError(
          (cause) =>
            new PostHogRequestError({
              message: "PostHog returned an unexpected cancelled TaskRun.",
              cause,
            }),
        ),
      );
    });

    const uploadRunArtifacts: PostHogCloudClient["Service"]["uploadRunArtifacts"] = Effect.fn(
      "PostHogCloudClient.uploadRunArtifacts",
    )(function* (input) {
      const connection = yield* transport.connection;
      const body = yield* transport.sendJson(connection, "post", runPath(input, "artifacts/"), {
        artifacts: input.artifacts.map((artifact) => ({
          name: artifact.name,
          type: "user_attachment",
          source: "t3code",
          content: artifact.base64,
          content_encoding: "base64",
          content_type: artifact.contentType,
        })),
      });
      const decoded = yield* decodeCloudArtifacts(body).pipe(
        Effect.mapError(
          (cause) =>
            new PostHogRequestError({
              message: "PostHog returned unexpected Cloud Task artifacts.",
              cause,
            }),
        ),
      );
      return decoded.artifacts;
    });

    const readRunLogs: PostHogCloudClient["Service"]["readRunLogs"] = Effect.fn(
      "PostHogCloudClient.readRunLogs",
    )(function* (input) {
      const connection = yield* transport.connection;
      const response = yield* transport.execute(
        connection,
        HttpClientRequest.get(transport.projectUrl(connection, runPath(input, "logs/"))),
        "while reading Cloud Task logs",
      );
      return yield* response.text.pipe(
        Effect.mapError(
          (cause) =>
            new PostHogRequestError({
              message: "PostHog returned unreadable Cloud Task logs.",
              cause,
            }),
        ),
      );
    });

    const streamRun: PostHogCloudClient["Service"]["streamRun"] = Effect.fn(
      "PostHogCloudClient.streamRun",
    )(function* (input) {
      const connection = yield* transport.connection;
      const request = HttpClientRequest.get(
        transport.projectUrl(connection, runPath(input, "stream/")),
      ).pipe(
        HttpClientRequest.setUrlParams(input.startLatest ? { start: "latest" } : {}),
        HttpClientRequest.setHeaders({
          accept: "text/event-stream",
          ...(input.lastEventId ? { "last-event-id": input.lastEventId } : {}),
        }),
      );
      const response = yield* transport.execute(
        connection,
        request,
        "while opening a Cloud Task stream",
      );
      return decodePostHogSse(response.stream).pipe(
        Stream.mapError(
          (cause) =>
            new PostHogRequestError({ message: "PostHog Cloud Task stream failed.", cause }),
        ),
      );
    });

    return PostHogCloudClient.of({
      listModels,
      listGatewayModels,
      createTask,
      runTask,
      getRun,
      commandRun,
      cancelRun,
      uploadRunArtifacts,
      readRunLogs,
      streamRun,
    });
  }),
);
