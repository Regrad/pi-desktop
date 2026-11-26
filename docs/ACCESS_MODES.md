# Access and approval

Each chat has two access options in the composer:

- **Agree first**, the default. The model can read files, search and discuss the
  task. Changes require approval through the interface.
- **Full access**. The model can use tools without mandatory change approval.

In Agree first, the model explains the proposal, affected files or objects and
significant risks once in the chat, then calls `request_changes` with `{}`.
Pi Desktop captures the visible text from that reply and binds approval to its
message and tool call. Thinking is never used as a proposal. The engine ends the
turn after saving tool results, without another model request or a waiting reply.
Only compact approval controls appear above the composer.
**Allow changes** only approves that exact revision. It does not
start generation. The user then sends an ordinary message, for example “go ahead”,
to begin work. A message such as “make it 128×128” before approval only refines the proposal; it never
approves it. Sending a clarification invalidates the previous review card.

Approval covers the agreed task across model turns and tool calls. A user
pause preserves it. A compact marker above the composer shows the current
permission and a cross to revoke it, including during execution. Revocation
blocks subsequent changes and aborts the current run; it does not undo changes
already made. Automatic continuations cannot start a newly approved task before
the user sends a message. When a normally completed task has no unfinished
checklist, goal or implementation document, access returns to read only.
An interrupted run without a resumable pause also loses its approval. Pending
work can continue under the same approval; additional scope needs a new
proposal. Selecting Full access persists until the user changes it.

**Plan mode is separate.** It requires a detailed document and blocks
implementation even when Full access is selected. Approving the document
also grants access for its implementation, so a second approval card is not
needed. Cancelling Plan mode does not grant change permission in Agree first.

The detailed document is required in Plan mode and cannot be read or edited by
the model outside it, including through codemode. Ordinary work uses the checklist
and notebook. After approval, the app passes the agreed scope to implementation
and closes the saved document after the implementation checklist is finished.
The system prompt and tool declarations stay constant when switching modes;
only an appended service state and live permissions change. This preserves the
existing request prefix instead of invalidating it by hiding a tool schema.

The application checks access at tool execution, including nested codemode
calls. Shell commands, unknown add-ons, generation tools, checklist writes
and skill changes stay blocked before approval. Native reads, searches and
planning-document edits remain available. Hidden model calls and Pi Lens
mutation hooks use the same live restrictions. The model cannot change its
access mode or approve its own proposal.

Editor connections and preflight checks also wait for approval. Creative skills
use native reads to investigate first, then start their editor workflow after
approval and the user's message. A proposal with no visible text or from an old
reply is rejected; selecting another history branch cannot approve stale text.

Access state lives in the chat record, independently of the system prompt
and tool catalog. Approving a task does not restart Pi or change tool schemas.
The local control API reports a pending proposal as `needs_input` and includes
its revision and contents in `approval`.
