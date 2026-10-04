# Foxy 3.1.1 controller fixture

Unmodified controller and its 18 transitive imports from `af2654f` (3.1.1).
Copied from the review experiment in `v32-review-A/.spider/scratch/review/old/`.
Only browser tests import these files. They are not part of the extension.

The shared-storage coexistence regression runs this controller beside the
current controller and edits both through pointer events. Keeping the real
old controller catches its automatic rewrite behaviour, not just a synthetic
legacy-key writer.
