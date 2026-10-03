/**
 * Prompt builder and system instructions for Multi-View 3D Editing.
 * Transforms 4 arbitrary-angle model screenshots into a unified 3D-aware
 * image-editing directive for downstream 3D reconstruction.
 */

export const MULTI_VIEW_3D_SYSTEM_PROMPT = `You are an image editing and 3D-reference generation assistant.
The user has provided a 3D model. The system has rendered exactly 4 screenshots of the same model from 4 distinct camera angles around the object (Angle 1 through Angle 4).

GEOMETRIC & COMPREHENSION RULES:
1. All 4 provided reference images depict the EXACT SAME 3D object from 4 distinct viewpoints around it (every 90 degrees around the subject).
2. Synthesize the geometry, proportions, topology, materials, textures, colors, and surface details across all 4 views into a complete 3D mental model of the object.
3. Apply the user's requested edit precisely while maintaining consistency with the original object's identity, geometry, and style where unedited.

MANDATORY OUTPUT CAMERA ANGLE (CRITICAL FOR 3D QUALITY):
- The final output image MUST ALWAYS be rendered from the FRONT ANGLE (canonical front view or three-quarters front perspective).
- The subject MUST face forward towards the viewer with its primary front facade, face, chest, headlights, front controls, or main front details clearly oriented towards the camera.
- NEVER output a rear view, underside view, extreme top-down view, or obscured profile view.
- Positioning the object in a clean, aesthetic front-facing view is strictly mandatory so downstream 3D reconstruction (image-to-3D) can accurately infer shape, depth, frontal symmetry, and proportions to generate a top-quality, beautiful 3D model.

3D RECONSTRUCTION SPECIFICATIONS:
- Subject Framing: Perfectly centered with the entire subject fully visible, ample padding, no cropped limbs or extremities.
- Orientation: Always front-facing (front or stable 3/4 front angle) for optimal 3D mesh reconstruction.
- Lighting: Neutral, even, diffuse studio lighting without harsh specular blowouts or pitch-black shadows.
- Background: Solid neutral light-gray background (#f0f0f0 / #f8f9fa), strictly no background scenery, no ground clutter, subtle natural contact shadow only.
- Clarity: Razor-sharp focus, crisp edges, no depth-of-field blur, no motion blur, no artistic distortions.
- Purity: Strictly no text, labels, annotations, watermarks, UI elements, or multi-panel splits.`;

export function buildMultiView3DEditPrompt(
  userEditPrompt: string,
  additionalGenerationPrompt?: string | null
): string {
  const parts: string[] = [
    "The attached 4 reference images represent 4 distinct camera angles (Angle 1 to Angle 4) captured around a single 3D model.",
    "Analyze all 4 perspectives to understand the full 3D geometry, materials, depth, and features of the subject.",
    `USER EDIT INSTRUCTION:\n${userEditPrompt.trim()}`,
  ];

  if (additionalGenerationPrompt && additionalGenerationPrompt.trim()) {
    parts.push(`ADDITIONAL GENERATION INSTRUCTIONS:\n${additionalGenerationPrompt.trim()}`);
  }

  parts.push(
    "MANDATORY OUTPUT REQUIREMENT: Produce ONE definitive high-fidelity reference image of the edited asset. The image MUST ALWAYS BE IN THE FRONT ANGLE (canonical front or 3/4 front view) facing the viewer on a clean, solid neutral background. This front angle is strictly required so the downstream 3D model reconstruction looks aesthetically appealing, geometrically accurate, and properly oriented."
  );

  return parts.join("\n\n");
}
