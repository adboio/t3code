/** Server-side PostHog reports API. Cloud Tasks live in PostHogCloudClient. */
import {
  type PostHogCurrentUserInput,
  type PostHogCurrentUserResult,
  PostHogReport,
  PostHogReportArtefact,
  type PostHogReportArtefactsInput,
  type PostHogReportArtefactsResult,
  type PostHogReportsListInput,
  type PostHogReportsListResult,
  type PostHogReportSignalsInput,
  type PostHogReportSignalsResult,
  PostHogSignal,
  PostHogRequestError,
  type PostHogRpcError,
  type PostHogSetReportStateInput,
  type PostHogSetReportStateResult,
  type PostHogSetReviewersInput,
  type PostHogSetReviewersResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { PostHogTransport } from "./PostHogTransport.ts";

const DEFAULT_LIST_LIMIT = 50;
const ARTEFACTS_LIST_LIMIT = 200;
const PaginatedReports = Schema.Struct({
  count: Schema.Number,
  results: Schema.Array(PostHogReport),
});
const PaginatedArtefacts = Schema.Struct({ results: Schema.Array(PostHogReportArtefact) });
const ReportSignalsBody = Schema.Struct({ signals: Schema.Array(PostHogSignal) });
const CurrentUserBody = Schema.Struct({
  github_login: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodePaginatedReports = Schema.decodeUnknownEffect(PaginatedReports);
const decodePaginatedArtefacts = Schema.decodeUnknownEffect(PaginatedArtefacts);
const decodeReportSignals = Schema.decodeUnknownEffect(ReportSignalsBody);
const decodeReport = Schema.decodeUnknownEffect(PostHogReport);
const decodeCurrentUser = Schema.decodeUnknownEffect(CurrentUserBody);
const decodeArtefact = Schema.decodeUnknownEffect(PostHogReportArtefact);

export class PostHogClient extends Context.Service<
  PostHogClient,
  {
    readonly listReports: (
      input: PostHogReportsListInput,
    ) => Effect.Effect<PostHogReportsListResult, PostHogRpcError>;
    readonly listReportArtefacts: (
      input: PostHogReportArtefactsInput,
    ) => Effect.Effect<PostHogReportArtefactsResult, PostHogRpcError>;
    readonly listReportSignals: (
      input: PostHogReportSignalsInput,
    ) => Effect.Effect<PostHogReportSignalsResult, PostHogRpcError>;
    readonly setReportState: (
      input: PostHogSetReportStateInput,
    ) => Effect.Effect<PostHogSetReportStateResult, PostHogRpcError>;
    readonly getCurrentUser: (
      input: PostHogCurrentUserInput,
    ) => Effect.Effect<PostHogCurrentUserResult, PostHogRpcError>;
    readonly setReviewers: (
      input: PostHogSetReviewersInput,
    ) => Effect.Effect<PostHogSetReviewersResult, PostHogRpcError>;
  }
>()("t3/posthog/PostHogClient") {}

export const layer = Layer.effect(
  PostHogClient,
  Effect.gen(function* () {
    const transport = yield* PostHogTransport;

    const listReports: PostHogClient["Service"]["listReports"] = Effect.fn(
      "PostHogClient.listReports",
    )(function* (input) {
      const connection = yield* transport.connection;
      const body = yield* transport.getJson(connection, "/signals/reports/", {
        limit: String(input.limit ?? DEFAULT_LIST_LIMIT),
        ...(input.status ? { status: input.status } : {}),
      });
      const page = yield* decodePaginatedReports(body).pipe(
        Effect.mapError(
          (cause) =>
            new PostHogRequestError({
              message: "PostHog returned an unexpected report list.",
              cause,
            }),
        ),
      );
      return { reports: page.results, count: page.count };
    });

    const listReportArtefacts: PostHogClient["Service"]["listReportArtefacts"] = Effect.fn(
      "PostHogClient.listReportArtefacts",
    )(function* (input) {
      const connection = yield* transport.connection;
      const body = yield* transport.getJson(
        connection,
        `/signals/reports/${encodeURIComponent(input.reportId)}/artefacts/`,
        { limit: String(ARTEFACTS_LIST_LIMIT) },
      );
      const page = yield* decodePaginatedArtefacts(body).pipe(
        Effect.mapError(
          (cause) =>
            new PostHogRequestError({
              message: "PostHog returned an unexpected artefact list.",
              cause,
            }),
        ),
      );
      return { artefacts: page.results };
    });

    const listReportSignals: PostHogClient["Service"]["listReportSignals"] = Effect.fn(
      "PostHogClient.listReportSignals",
    )(function* (input) {
      const connection = yield* transport.connection;
      const body = yield* transport.getJson(
        connection,
        `/signals/reports/${encodeURIComponent(input.reportId)}/signals/`,
        {},
      );
      const decoded = yield* decodeReportSignals(body).pipe(
        Effect.mapError(
          (cause) =>
            new PostHogRequestError({
              message: "PostHog returned an unexpected signal list.",
              cause,
            }),
        ),
      );
      return { signals: decoded.signals };
    });

    const setReportState: PostHogClient["Service"]["setReportState"] = Effect.fn(
      "PostHogClient.setReportState",
    )(function* (input) {
      const connection = yield* transport.connection;
      const body = yield* transport.sendJson(
        connection,
        "post",
        `/signals/reports/${encodeURIComponent(input.reportId)}/state/`,
        { state: input.state },
      );
      const report = yield* decodeReport(body).pipe(
        Effect.mapError(
          (cause) =>
            new PostHogRequestError({ message: "PostHog returned an unexpected report.", cause }),
        ),
      );
      return { report };
    });

    const getCurrentUser: PostHogClient["Service"]["getCurrentUser"] = Effect.fn(
      "PostHogClient.getCurrentUser",
    )(function* () {
      const connection = yield* transport.connection;
      const body = yield* transport.getUrlJson(
        connection,
        `${connection.host}/api/users/@me/github_login/`,
        {},
      );
      const decoded = yield* decodeCurrentUser(body).pipe(
        Effect.mapError(
          (cause) =>
            new PostHogRequestError({ message: "PostHog returned an unexpected user.", cause }),
        ),
      );
      return { github_login: decoded.github_login ?? null };
    });

    const setReviewers: PostHogClient["Service"]["setReviewers"] = Effect.fn(
      "PostHogClient.setReviewers",
    )(function* (input) {
      const connection = yield* transport.connection;
      const body = yield* transport.sendJson(
        connection,
        "put",
        `/signals/reports/${encodeURIComponent(input.reportId)}/reviewers/`,
        { content: input.content },
      );
      const artefact = yield* decodeArtefact(body).pipe(
        Effect.mapError(
          (cause) =>
            new PostHogRequestError({ message: "PostHog returned an unexpected artefact.", cause }),
        ),
      );
      return { artefact };
    });

    return PostHogClient.of({
      listReports,
      listReportArtefacts,
      listReportSignals,
      setReportState,
      getCurrentUser,
      setReviewers,
    });
  }),
);
