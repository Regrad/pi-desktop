# Access and approval

Each chat has two access options in the composer:

- **Agree first**, the default. The model can read files, search and discuss the
  task. Changes require approval through the interface.
- **Full access**. The model can use tools without mandatory change approval.

In Agree first, the model calls `request_changes` with a short description,
affected files or objects, and significant risks. The model explains the proposal
once in the chat. Only compact approval controls appear above the composer.
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

The application checks access at tool execution, including nested codemode
calls. Shell commands, unknown add-ons, generation tools, checklist writes
and skill changes stay blocked before approval. Native reads, searches and
planning-document edits remain available. Hidden model calls and Pi Lens
mutation hooks use the same live restrictions. The model cannot change its
access mode or approve its own proposal.

Access state lives in the chat record, independently of the system prompt
and tool catalog. Approving a task does not restart Pi or change tool schemas.
The local control API reports a pending proposal as `needs_input` and includes
its revision and contents in `approval`.
