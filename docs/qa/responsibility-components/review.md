# Independent review and resolution

Astra medium reviewed the tracked and untracked component mapping, scanner
integration, inspector navigation, reservation filtering, and recorded QA after
implementation and the initial green checks. It reported one actionable P2:
an older neighborhood request could finish after a newer selection and override
the scene, lens, camera, and inspector.

The coordinator resolved this using a latest-request publication guard with
navigation values, selection, and fixture identity checks, plus cancellation
on close/unmount. Neighborhood caching itself is allowed to finish. The
controller also suppresses obsolete errors. Four tests cover deferred loads
finishing out of order, later selection, cancellation, and equivalent navigation
objects across renders.

Astra low retested the real nonresident declaration and pinned Source flow after
the correction and passed it. The initial object-reference comparison was found
by that QA to reject valid clicks, and was replaced with stable navigation-value
comparison before the passing retest.

The reviewer found no other actionable issues in map validation, atomic
rejection, observed call/evidence retention, or the component reservation fix.
It noted that arbitrary externally supplied extraction metadata may need
canonicalization if the mapping API is later used on enriched bases; current
scanner relation descriptors do not emit those optional metadata variations.

A second independent pass on the race fix could not be dispatched because the
agent thread limit rejected both the original reviewer follow-up and a new
reviewer. Resolution is supported by the coordinator's checks and Astra low
browser retest, not a claimed second Astra medium approval.
