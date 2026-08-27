import {
  PostHogNotConfiguredError,
  PostHogRequestError,
  type PostHogRpcError,
  PostHogUnauthorizedError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { POSTHOG_API_KEY_SECRET_NAME, ServerSettingsService } from "../serverSettings.ts";

const textDecoder = new TextDecoder();

export interface PostHogConnection {
  readonly host: string;
  readonly projectId: string;
  readonly apiKey: string;
}

export class PostHogTransport extends Context.Service<
  PostHogTransport,
  {
    readonly connection: Effect.Effect<PostHogConnection, PostHogRpcError>;
    readonly projectUrl: (connection: PostHogConnection, path: string) => string;
    readonly getUrlJson: (
      connection: PostHogConnection,
      url: string,
      urlParams: Readonly<Record<string, string>>,
    ) => Effect.Effect<unknown, PostHogRpcError>;
    readonly getJson: (
      connection: PostHogConnection,
      path: string,
      urlParams: Readonly<Record<string, string>>,
    ) => Effect.Effect<unknown, PostHogRpcError>;
    readonly sendJson: (
      connection: PostHogConnection,
      method: "post" | "put",
      path: string,
      body: unknown,
    ) => Effect.Effect<unknown, PostHogRpcError>;
    readonly execute: (
      connection: PostHogConnection,
      request: HttpClientRequest.HttpClientRequest,
      context: string,
    ) => Effect.Effect<HttpClientResponse.HttpClientResponse, PostHogRpcError>;
  }
>()("t3/posthog/PostHogTransport") {}

export const layer = Layer.effect(
  PostHogTransport,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const serverSettings = yield* ServerSettingsService;
    const secretStore = yield* ServerSecretStore.ServerSecretStore;

    const connection = Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new PostHogRequestError({ message: "Failed to read PostHog settings.", cause }),
        ),
      );
      const secret = yield* secretStore
        .get(POSTHOG_API_KEY_SECRET_NAME)
        .pipe(
          Effect.mapError(
            (cause) =>
              new PostHogRequestError({ message: "Failed to read the PostHog API key.", cause }),
          ),
        );
      const host = settings.posthog.host.replace(/\/+$/, "");
      const projectId = settings.posthog.projectId;
      const apiKey = Option.isSome(secret) ? textDecoder.decode(secret.value).trim() : "";
      const missing: Array<"host" | "projectId" | "apiKey"> = [];
      if (!host) missing.push("host");
      if (!projectId) missing.push("projectId");
      if (!apiKey) missing.push("apiKey");
      if (missing.length > 0) return yield* new PostHogNotConfiguredError({ missing });
      return { host, projectId, apiKey };
    });

    const projectUrl = (resolved: PostHogConnection, path: string) =>
      `${resolved.host}/api/projects/${encodeURIComponent(resolved.projectId)}${path}`;

    const execute = Effect.fn("PostHogTransport.execute")(function* (
      resolved: PostHogConnection,
      request: HttpClientRequest.HttpClientRequest,
      context: string,
    ) {
      const response = yield* httpClient
        .execute(
          HttpClientRequest.setHeaders(request, {
            accept: request.headers.accept ?? "application/json",
            authorization: `Bearer ${resolved.apiKey}`,
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new PostHogRequestError({
                message: `PostHog request failed: ${cause.message}`,
                cause,
              }),
          ),
        );
      if (response.status === 401 || response.status === 403) {
        return yield* new PostHogUnauthorizedError({ status: response.status });
      }
      if (response.status < 200 || response.status >= 300) {
        return yield* new PostHogRequestError({
          message: `PostHog answered ${response.status} ${context}.`,
          status: response.status,
        });
      }
      return response;
    });

    const getUrlJson = Effect.fn("PostHogTransport.getUrlJson")(function* (
      resolved: PostHogConnection,
      url: string,
      urlParams: Readonly<Record<string, string>>,
    ) {
      const response = yield* execute(
        resolved,
        HttpClientRequest.get(url).pipe(HttpClientRequest.setUrlParams(urlParams)),
        `for ${url}`,
      );
      return yield* response.json.pipe(
        Effect.mapError(
          (cause) =>
            new PostHogRequestError({ message: "PostHog returned an unreadable body.", cause }),
        ),
      );
    });

    const getJson = (resolved: PostHogConnection, path: string, params: Record<string, string>) =>
      getUrlJson(resolved, projectUrl(resolved, path), params);

    const sendJson = Effect.fn("PostHogTransport.sendJson")(function* (
      resolved: PostHogConnection,
      method: "post" | "put",
      path: string,
      body: unknown,
    ) {
      const request = (
        method === "put"
          ? HttpClientRequest.put(projectUrl(resolved, path))
          : HttpClientRequest.post(projectUrl(resolved, path))
      ).pipe(HttpClientRequest.bodyJsonUnsafe(body));
      const response = yield* execute(resolved, request, `for ${path}`);
      return yield* response.json.pipe(
        Effect.mapError(
          (cause) =>
            new PostHogRequestError({ message: "PostHog returned an unreadable body.", cause }),
        ),
      );
    });

    return PostHogTransport.of({
      connection,
      projectUrl,
      getUrlJson,
      getJson,
      sendJson,
      execute,
    });
  }),
);
