------------------------------- MODULE IndexRebuild -------------------------------
(***************************************************************************)
(* Boots that run together on one table whose index `N` was built by an    *)
(* older function. Each boot is `ensureIndexes` -> `applyIndexPlan` ->      *)
(* `rebuildIndex` -> `swapInRebuild` in src/implementations/database/       *)
(* initialize.ts, and every line below that sends one request to the        *)
(* server is one step. The server state is what `index_status` shows for    *)
(* `N` and for `N__rebuild`. `\* file.ts:NN` names the line of the code a    *)
(* step stands for.                                                         *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
  Boots,           \* the processes that boot together
  Attempts,        \* REBUILD_ATTEMPTS (initialize.ts:31)
  Queries,         \* how many reads of N run while the boots do
  LeftoverRebuild, \* TRUE when an earlier boot left N__rebuild built by the old function
  SwapByDrop,      \* variant, FALSE in the code: drop N, then rename without overwrite
  SwapByCopy,      \* variant, FALSE in the code: copy the rebuild over N and keep it
  KeepLeftover,    \* variant, FALSE in the code: never drop a leftover rebuild of another function
  NoReread         \* variant, FALSE in the code: a failed attempt throws without reading the index again

ASSUME Attempts \in Nat \ {0}
ASSUME Queries \in Nat

VARIABLES
  stored,   \* the function N holds: "old", "new", or "none" while a swap has dropped it
  rebuild,  \* the function N__rebuild holds: "none", "old" or "new"
  ready,    \* whether N__rebuild has finished building
  pc,       \* where each boot is
  left,     \* the attempts a boot has left after the one it runs
  seen,     \* what `planIndexes` last read for N__rebuild: "missing", "stale" or "current"
  asked,    \* the queries that ran
  missed    \* the queries that found no index N

vars == <<stored, rebuild, ready, pc, left, seen, asked, missed>>

Ended == {"done", "failed"}

TypeOK ==
  /\ stored \in {"old", "new", "none"}
  /\ rebuild \in {"none", "old", "new"}
  /\ ready \in BOOLEAN
  /\ pc \in [Boots -> {"plan", "drop", "create", "wait", "rename", "rename2", "reread", "done", "failed"}]
  /\ left \in [Boots -> 0..(Attempts - 1)]
  /\ seen \in [Boots -> {"missing", "stale", "current"}]
  /\ asked \in 0..Queries
  /\ missed \in 0..Queries

Init ==
  /\ stored = "old"
  /\ rebuild = IF LeftoverRebuild THEN "old" ELSE "none"
  /\ ready = TRUE
  /\ pc = [b \in Boots |-> "plan"]
  /\ left = [b \in Boots |-> Attempts - 1]
  /\ seen = [b \in Boots |-> "missing"]
  /\ asked = 0
  /\ missed = 0

\* How `compareIndex` judges the index stored under N__rebuild (index-state.ts:93, 129).
RebuildState ==
  IF rebuild = "none" THEN "missing" ELSE IF rebuild = "old" THEN "stale" ELSE "current"

\* A step that threw: `rebuildIndex` goes to its catch block.
Throws(b) == pc' = [pc EXCEPT ![b] = "reread"]

\* initialize.ts:157 and 139, `planIndexes` and `applyIndexPlan`: one `index_status` read says whether N is current.
Plan(b) ==
  /\ pc[b] = "plan"
  /\ IF stored = "new"
       THEN /\ pc' = [pc EXCEPT ![b] = "done"]
            /\ UNCHANGED seen
       ELSE /\ pc' = [pc EXCEPT ![b] = "drop"]
            /\ seen' = [seen EXCEPT ![b] = RebuildState]
  /\ UNCHANGED <<stored, rebuild, ready, left, asked, missed>>

\* initialize.ts:91, `INDEX_DROP` of a leftover rebuild built by another function.
Drop(b) ==
  /\ pc[b] = "drop"
  /\ IF seen[b] = "stale" /\ ~KeepLeftover
       THEN IF rebuild # "none"
              THEN /\ rebuild' = "none"
                   /\ pc' = [pc EXCEPT ![b] = "create"]
              ELSE /\ Throws(b)
                   /\ UNCHANGED rebuild
       ELSE /\ pc' = [pc EXCEPT ![b] = "create"]
            /\ UNCHANGED rebuild
  /\ UNCHANGED <<stored, ready, left, seen, asked, missed>>

\* initialize.ts:94, `createIndex` ignores "already exists" (initialize.ts:28), so a rebuild another boot made stays.
Create(b) ==
  /\ pc[b] = "create"
  /\ IF rebuild = "none"
       THEN /\ rebuild' = "new"
            /\ ready' = FALSE
       ELSE UNCHANGED <<rebuild, ready>>
  /\ pc' = [pc EXCEPT ![b] = "wait"]
  /\ UNCHANGED <<stored, left, seen, asked, missed>>

\* initialize.ts:95, `INDEX_WAIT` fails on a missing index and waits for one that is building.
Wait(b) ==
  /\ pc[b] = "wait"
  /\ IF rebuild = "none"
       THEN Throws(b)
       ELSE /\ ready
            /\ pc' = [pc EXCEPT ![b] = "rename"]
  /\ UNCHANGED <<stored, rebuild, ready, left, seen, asked, missed>>

\* initialize.ts:96, `INDEX_RENAME` with `overwrite: true` is one request: N holds the rebuild's function and N__rebuild is gone.
Rename(b) ==
  /\ pc[b] = "rename"
  /\ IF rebuild = "none"
       THEN /\ Throws(b)
            /\ UNCHANGED <<stored, rebuild>>
       ELSE IF SwapByDrop
         THEN /\ stored' = "none"
              /\ pc' = [pc EXCEPT ![b] = "rename2"]
              /\ UNCHANGED rebuild
         ELSE /\ stored' = rebuild
              /\ rebuild' = IF SwapByCopy THEN rebuild ELSE "none"
              /\ pc' = [pc EXCEPT ![b] = "done"]
  /\ UNCHANGED <<ready, left, seen, asked, missed>>

\* Variant only: the second request of a swap that dropped N first.
RenameAfterDrop(b) ==
  /\ pc[b] = "rename2"
  /\ stored' = rebuild
  /\ rebuild' = "none"
  /\ pc' = [pc EXCEPT ![b] = "done"]
  /\ UNCHANGED <<ready, left, seen, asked, missed>>

\* initialize.ts:120, the catch block of `rebuildIndex`: read the index again, stop once it is current, otherwise retry from what was read.
Reread(b) ==
  /\ pc[b] = "reread"
  /\ IF NoReread
       THEN pc' = [pc EXCEPT ![b] = "failed"]
       ELSE IF stored = "new"
         THEN pc' = [pc EXCEPT ![b] = "done"]
         ELSE IF left[b] = 0
           THEN pc' = [pc EXCEPT ![b] = "failed"]
           ELSE pc' = [pc EXCEPT ![b] = "drop"]
  /\ left' = IF ~NoReread /\ stored # "new" /\ left[b] > 0
               THEN [left EXCEPT ![b] = left[b] - 1]
               ELSE left
  /\ seen' = IF ~NoReread /\ stored # "new" /\ left[b] > 0
               THEN [seen EXCEPT ![b] = RebuildState]
               ELSE seen
  /\ UNCHANGED <<stored, rebuild, ready, asked, missed>>

\* The server finishes building N__rebuild.
BuildFinishes ==
  /\ rebuild # "none"
  /\ ~ready
  /\ ready' = TRUE
  /\ UNCHANGED <<stored, rebuild, pc, left, seen, asked, missed>>

\* A read that uses index N.
Query ==
  /\ asked < Queries
  /\ asked' = asked + 1
  /\ missed' = IF stored = "none" THEN missed + 1 ELSE missed
  /\ UNCHANGED <<stored, rebuild, ready, pc, left, seen>>

Finished ==
  /\ \A b \in Boots : pc[b] \in Ended
  /\ asked = Queries
  /\ ~(rebuild # "none" /\ ~ready)
  /\ UNCHANGED vars

Next ==
  \/ \E b \in Boots : Plan(b) \/ Drop(b) \/ Create(b) \/ Wait(b) \/ Rename(b) \/ RenameAfterDrop(b) \/ Reread(b)
  \/ BuildFinishes
  \/ Query
  \/ Finished

Spec == Init /\ [][Next]_vars

\* Every read of N finds an index, the old one until a swap and the new one after.
QueriesFindAnIndex == missed = 0

\* A boot that ends well leaves the declared function stored under N.
BootsStoreTheDeclaredFunction == (\E b \in Boots : pc[b] = "done") => stored = "new"

\* Once every boot has ended, no N__rebuild is left behind.
NoRebuildLeftBehind == (\A b \in Boots : pc[b] \in Ended) => rebuild = "none"

\* No boot throws its last attempt while another boot is still running.
NoBootFailsWhileOthersProgress ==
  (\E b \in Boots : pc[b] = "failed") => (\A b \in Boots : pc[b] \in Ended)

Sym == Permutations(Boots)
=============================================================================
