import {
  applyWaterSceneOp,
  loadWaterSceneForJob,
  type WaterSceneBundle,
  type WaterSceneOp,
} from "../../../repository/waterEngine.js";
import { experienceV0 } from "./experience.js";
import type { SceneMaterialPatch, Vec3 } from "../scene/ir.js";

export async function composeWaterScene(params: {
  userId: string;
  jobId: string;
}): Promise<WaterSceneBundle | null> {
  return loadWaterSceneForJob(params.jobId, params.userId);
}

export async function editWaterScene(params: {
  userId: string;
  jobId: string;
  op: WaterSceneOp;
  position?: Vec3;
  rotation?: Vec3;
  scale?: Vec3;
  material?: SceneMaterialPatch | null;
  partName?: string | null;
}): Promise<WaterSceneBundle | null> {
  return applyWaterSceneOp(params);
}

export function sceneCameraFromBundle(bundle: WaterSceneBundle | null) {
  return experienceV0({
    sockets: bundle?.meshNames?.length ? bundle.meshNames.slice(0, 8) : ["root"],
    camera: bundle?.ir.camera,
  });
}
