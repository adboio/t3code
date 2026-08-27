# PostHog Cloud Tasks

PostHog Cloud is a t3 provider. It keeps t3's thread and event-sourced UI while PostHog owns the agent process, sandbox, GitHub credentials, compute limits, and billing.

## Identity and ownership

A t3 thread binds to one execution provider for its lifetime. A Cloud thread stores only the PostHog Task id, current TaskRun id, repository name, and the last consumed stream event id. PostHog remains the source of truth for TaskRun status, run ancestry, logs, artifacts, branches, and pull requests.

A PostHog Task is the durable remote conversation. A TaskRun is one sandbox lease for that Task. Active follow-up messages continue the current TaskRun. A follow-up after a terminal TaskRun creates a successor with `resume_from_run_id`; the t3 thread continues across both runs.

`_posthog/turn_complete` completes a turn without completing the TaskRun. The composer working state follows the active turn, not merely a TaskRun whose status is `in_progress`.

A message sent while a turn is active carries an explicit steer intent and the request-time turn owner through orchestration. The adapter reuses that t3 turn id and sends the Cloud command with `steer: true`; the request does not create pending-turn or checkpoint bookkeeping and does not publish another `turn.started`. The command id is the t3 message id, so PostHog can deduplicate a retried delivery.

PostHog can continue producing output after the prompt lifecycle T3 originally tracked has ended. `_posthog/background_turn_started` opens a visible synthetic turn and `_posthog/background_turn_complete` closes it. If content arrives without the start notification, the first assistant, reasoning, plan, tool, permission, or external prompt event opens the same kind of implicit turn. This matches PostHog Desktop's append-only conversation builder and prevents ownerless assistant buffers from disappearing.

t3 only stores and controls Tasks it created. It does not import a user's complete PostHog Task history.

## Provider behavior

The t3 server owns the PostHog personal API key and all Cloud API traffic. Reports and Cloud Tasks have separate service surfaces over one authenticated PostHog transport. The Cloud adapter opens one upstream SSE connection for each live TaskRun; a schema-backed protocol module translates Agent Client Protocol messages into t3 provider runtime events, while a run-session state owner tracks cursors, deduplication, active items, and permissions. Web, desktop, mobile, remote, and tunnel clients continue to receive the existing t3 snapshot and WebSocket event stream.

The stream connects before historical logs finish loading. The adapter buffers live frames, folds the historical JSONL snapshot by durable line position, removes only the matching buffered copies, then drains the live tail. Matching canonicalizes the JSONL `message` and SSE `notification` envelopes, ignores transport timestamps and object-key order, and still counts repeated semantic events individually. Identical text chunks remain distinct log entries. It keeps both the latest SSE event id and processed JSONL entry count in the live session; meaningful runtime boundaries persist that cursor to the provider binding, while high-volume text and token deltas do not write SQLite individually. Reconciliation consumes live/log copies in order, and a malformed JSONL tail is retried before the cursor may pass it. Reconnects resume with `Last-Event-ID` and reconcile the authoritative full log before retrying, so a missing live batch is repaired without restarting t3. A disconnected stream also triggers an authoritative TaskRun status read; transport loss alone never marks a run failed.

PostHog's model catalogue supplies the available runtime adapters, models, and reasoning levels. PostHog run configuration owns permission defaults. t3 does not maintain independent allowlists for either. GitHub installation and authentication also remain PostHog concerns.

Cloud task creation enables pull request tooling but does not request automatic publication. The agent only creates a pull request when the prompt asks it to.

## Commands

Sending a message starts a Task and TaskRun when the thread has no Task id. Later messages use the current active run or create a successor run after a terminal status.

Composer Stop sends the run `cancel` command, which interrupts the current agent turn while preserving the sandbox. Stop run calls the TaskRun cancellation endpoint after confirmation; PostHog then stops the workflow and destroys the sandbox.

Closing t3 or refreshing the provider stops only the local stream watcher. It does not cancel the PostHog TaskRun.

Approval and structured user-input cards use the existing t3 request surfaces. Responses return through the TaskRun command endpoint. Replayed unresolved requests restore those cards without repeating already observed side effects.

`session/prompt` entries sent from PostHog Desktop or another surface become user messages in the t3 transcript. T3 registers its own outgoing prompt text and consumes the corresponding stream echo; ingestion also suppresses a matching recent local message during historical replay.

Attachments are uploaded to the active PostHog TaskRun and passed as artifact ids with the next message. An attachment-first TaskRun starts idle so the agent receives the prompt and its artifacts together.

## Cloud workspace

Cloud threads do not expose a local terminal, local file tree, staging actions, checkpoints, rewind, or discard.

Clients do not decide that by recognising the PostHog Cloud provider. The provider declares `execution: "remote"`, and the shared `threadWorkspaceCapabilities` selector derives `hasLocalWorkspace` and `canStopSession` for web and mobile. Until provider capabilities load, local-workspace actions stay unavailable instead of briefly exposing invalid controls. Attachment transport is independent: the Cloud adapter declares `attachmentMode: "upload"`, while local adapters retain path-enriched prompts. Any future provider inherits these behaviors by declaring capabilities; nothing keys on a driver slug. Streamed file changes and diffs provide the working view until PostHog reports canonical branch or pull-request metadata, which then becomes the authoritative durable result.

The prototype starts Cloud threads from an existing t3 project and passes its GitHub repository identity to PostHog. The provider contract keeps repository identity separate from a local path so a future PostHog repository picker can create remote-only projects without changing thread identity.

- No remote-only repository picker yet. Starting a Cloud thread requires an existing t3 project with a GitHub repository identity.

## Presentation

Cloud uses the normal t3 transcript, tool, plan, approval, question, error, diff, branch, and pull request components. Infrastructure progress stays in the existing working row instead of becoming permanent transcript cards.

Before transcript output, `queued` displays “Waiting in the queue…” and `in_progress` displays “Starting the sandbox…”. `_posthog/progress` labels such as “Restoring sandbox”, “Cloning repository”, and “Starting agent” replace that text as they arrive. Progress steps use separate identities: setup remains in the working log, CI keeps its own row, and a completed `pr` step links the pull request to the thread instead of being overwritten by later CI progress.

Report actions remain prompt shortcuts, not execution modes. “Ask about it” creates a normal Cloud conversation. “Implement it” starts with its implementation prompt. Report-linked discussion tasks use the `discussion` relationship; a later pull request from that thread may not count as a formal Signals implementation for PostHog linkage, quotas, or billing.

## Deliberate limits

These are prototype limits, not compatibility guarantees. Preserve the Task, TaskRun, repository, and cursor identities so explicit handoff and richer run history can be added without changing thread identity.
