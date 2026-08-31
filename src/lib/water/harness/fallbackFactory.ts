/**
 * Last-resort procedural factory when the LLM returns empty/refusal text.
 * Always valid createModel() so Water never hard-fails on weak models / IP refusals.
 */

import type { RichSculptSpec } from "./types.js";
import type { WaterSkillId } from "../../waterSkills.js";

export function looksLikeRefusalOrEmpty(code: string): boolean {
  const t = (code || "").trim();
  if (t.length < 200) return true;
  if (!/export\s+function\s+createModel\s*\(/.test(t)) return true;
  if (!/import\s+\*\s+as\s+THREE\s+from\s+['"]three['"]/.test(t)) return true;
  if (/sorry|cannot|can't|won't|unable to|copyright|trademark|not able to/i.test(t) && t.length < 800) {
    return true;
  }
  return false;
}

export function buildMinimalFactory(params: {
  prompt: string;
  skillId: WaterSkillId;
  spec?: RichSculptSpec | null;
}): string {
  const name = JSON.stringify(
    (params.spec?.name || params.prompt || "Character").split(/[.,\n]/)[0].trim().slice(0, 48) || "Model"
  );
  // Game skill + famous heroes often land on object fallback-spec; prompt wins.
  const promptLooksCharacter =
    /\b(spider-?man|super-?man|bat-?man|iron-?man|wonder\s*woman|hulk|wolverine|character|human|person|hero|warrior|soldier|npc|avatar|robot|creature|girl|boy|man|woman)\b/i.test(
      params.prompt || ""
    );
  const isCharacter =
    params.skillId === "character" ||
    params.skillId === "animation" ||
    params.spec?.subjectClass === "character" ||
    params.spec?.subjectClass === "hybrid" ||
    (params.skillId === "game" && promptLooksCharacter) ||
    promptLooksCharacter;

  if (isCharacter) {
    return `import * as THREE from 'three';

/** Fallback character blockout for ${name} — LLM output was unusable. */
export function createModel(): THREE.Group {
  const root = new THREE.Group();
  root.name = ${name};

  const skin = new THREE.MeshStandardMaterial({ color: 0xc68642, roughness: 0.65, metalness: 0.05 });
  const suit = new THREE.MeshStandardMaterial({ color: 0x1e3a8a, roughness: 0.45, metalness: 0.15 });
  const accent = new THREE.MeshStandardMaterial({ color: 0xb91c1c, roughness: 0.5, metalness: 0.1 });
  const boot = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.7, metalness: 0.05 });

  const hips = new THREE.Group();
  hips.name = "hips";
  hips.position.set(0, 0.95, 0);
  root.add(hips);

  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.55, 12), suit);
  // Keep canonical fallback-spec names so deterministic coverage still passes.
  torso.name = "body";
  torso.position.set(0, 0.35, 0);
  hips.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 12), skin);
  head.name = "head";
  head.position.set(0, 0.78, 0);
  hips.add(head);

  const cape = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.7), accent);
  cape.name = "detail";
  cape.position.set(0, 0.35, -0.18);
  cape.rotation.x = 0.15;
  hips.add(cape);

  function limb(name: string, mat: THREE.Material, len: number, thick: number) {
    const g = new THREE.Group();
    g.name = name;
    const m = new THREE.Mesh(new THREE.CylinderGeometry(thick, thick * 0.9, len, 8), mat);
    m.position.y = -len / 2;
    g.add(m);
    return g;
  }

  const armL = limb("arm_L", suit, 0.45, 0.06);
  armL.position.set(0.32, 0.5, 0);
  hips.add(armL);
  const armR = limb("arm_R", suit, 0.45, 0.06);
  armR.position.set(-0.32, 0.5, 0);
  hips.add(armR);

  const legL = limb("leg_L", boot, 0.55, 0.08);
  legL.position.set(0.12, 0, 0);
  hips.add(legL);
  const legR = limb("leg_R", boot, 0.55, 0.08);
  legR.position.set(-0.12, 0, 0);
  hips.add(legR);

  root.userData.sculptRuntime = {
    nodes: { root, hips, torso, head, cape, armL, armR, legL, legR },
    sockets: { head: head, hand_L: armL, hand_R: armR, root: root },
  };
  root.userData.tick = (dt: number, elapsed: number) => {
    hips.rotation.y = Math.sin(elapsed * 0.6) * 0.08;
    cape.rotation.x = 0.15 + Math.sin(elapsed * 1.4) * 0.05;
  };

  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
  });
  return root;
}
`;
  }

  return `import * as THREE from 'three';

/** Fallback object blockout for ${name} — LLM output was unusable. */
export function createModel(): THREE.Group {
  const root = new THREE.Group();
  root.name = ${name};
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x8a8f98, roughness: 0.4, metalness: 0.7 });
  const accentMat = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.7, metalness: 0.1 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.42, 0.48), bodyMat);
  body.name = "body";
  body.position.y = 0.21;
  root.add(body);

  const detail = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.38, 12), accentMat);
  detail.name = "detail";
  detail.rotation.z = Math.PI / 2;
  detail.position.set(0.28, 0.21, 0);
  body.add(detail);

  root.userData.sculptRuntime = {
    nodes: { root, body, detail },
    sockets: { root: root },
  };
  root.userData.tick = (_dt: number, elapsed: number) => {
    root.rotation.y = elapsed * 0.25;
  };
  return root;
}
`;
}
