# ADR-003: Memory Address V2 and principal identity

Status: accepted and implemented as a pure slice.

Make tenant, principal, agent, workspace/project/platform/account,
conversation/thread/customer/task, visibility, and retention explicit.
Namespace unlinked platform identities. Never merge identities by nickname.
Apply address policy before candidate retrieval, not after text leaves storage.
