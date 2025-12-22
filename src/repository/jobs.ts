import { supabase } from "../db.js";
import { GenerateType, JobRecord, JobStatus, PolygonType } from "../types.js";
import { logger } from "../logger.js";

export async function createJob(params: {
  id: string;
  prompt?: string | null;
  imageUrl?: string | null;
  generateType: GenerateType;
  faceCount?: number | null;
  enablePBR?: boolean;
  polygonType?: PolygonType | null;
}) {
  const {
    id,
    prompt = null,
    imageUrl = null,
    generateType,
    faceCount = null,
    enablePBR = true,
    polygonType = null,
  } = params;

  try {
    const { error } = await supabase.from("jobs").insert({
      id,
      status: "WAIT",
      prompt,
      image_url: imageUrl,
      generate_type: generateType,
      face_count: faceCount,
      enable_pbr: enablePBR,
      polygon_type: polygonType,
    });

    if (error) throw error;
  } catch (err: any) {
    logger.error(err, "Failed to create job in database");
    throw new Error(`Database error: ${err.message}`);
  }
}

export async function updateJobStatus(jobId: string, data: { status: JobStatus; errorCode?: string | null; errorMessage?: string | null }) {
  const { status, errorCode = null, errorMessage = null } = data;
  try {
    const { error } = await supabase
      .from("jobs")
      .update({
        status,
        error_code: errorCode,
        error_message: errorMessage,
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId);

    if (error) throw error;
  } catch (err: any) {
    logger.error(err, "Failed to update job status");
    throw new Error(`Database error: ${err.message}`);
  }
}

export async function updateJobResult(jobId: string, data: { resultGlbUrl?: string | null; previewImageUrl?: string | null }) {
  const { resultGlbUrl = null, previewImageUrl = null } = data;
  try {
    const { error } = await supabase
      .from("jobs")
      .update({
        result_glb_url: resultGlbUrl,
        preview_image_url: previewImageUrl,
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId);

    if (error) throw error;
  } catch (err: any) {
    logger.error(err, "Failed to update job result");
    throw new Error(`Database error: ${err.message}`);
  }
}

export async function getJob(jobId: string): Promise<JobRecord | null> {
  try {
    const { data, error } = await supabase.from("jobs").select("*").eq("id", jobId).single();
    if (error) {
      if (error.code === "PGRST116") return null; // Not found
      throw error;
    }
    if (!data) return null;
    return mapRow(data);
  } catch (err: any) {
    logger.error(err, "Failed to get job from database");
    throw new Error(`Database error: ${err.message}`);
  }
}

export async function listJobs(limit = 50): Promise<JobRecord[]> {
  try {
    const { data, error } = await supabase
      .from("jobs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw error;
    if (!data) return [];
    return data.map(mapRow);
  } catch (err: any) {
    logger.error(err, "Failed to list jobs from database");
    throw new Error(`Database error: ${err.message}`);
  }
}

function mapRow(row: any): JobRecord {
  return {
    id: row.id,
    status: row.status,
    prompt: row.prompt,
    imageUrl: row.image_url,
    generateType: row.generate_type,
    faceCount: row.face_count,
    enablePBR: row.enable_pbr,
    polygonType: row.polygon_type,
    resultGlbUrl: row.result_glb_url,
    previewImageUrl: row.preview_image_url,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

