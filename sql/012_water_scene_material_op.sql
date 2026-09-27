-- Allow per-part material edits in the Water scene op log.
ALTER TABLE public.water_scene_ops DROP CONSTRAINT IF EXISTS water_scene_ops_op_check;
ALTER TABLE public.water_scene_ops
  ADD CONSTRAINT water_scene_ops_op_check
  CHECK (op IN ('move', 'rotate', 'scale', 'material', 'duplicate', 'delete'));
