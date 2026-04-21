export type JobStatus = "WAIT" | "RUN" | "FAIL" | "DONE";

export type GenerateType =
  | "Normal"
  | "LowPoly"
  | "Geometry"
  | "Sketch"
  | "TextToImage"
  | "TextTo3D"
  | "ImageTo3D"
  | "EditImage"
  | "Combined";

export type PolygonType = "triangle" | "quadrilateral";

export interface CreateJobInput {
  prompt?: string;
  imageUrl?: string;
  imageBase64?: string;
  multiViewImages?: Array<{ viewType: "left" | "right" | "back"; viewImageUrl: string }>;
  enablePBR?: boolean;
  faceCount?: number;
  generateType?: GenerateType;
  polygonType?: PolygonType;
}

export interface JobRecord {
  id: string;
  userId: string | null;  // Owner of the job
  chatId: string | null;  // Chat this job belongs to
  workspaceId: string | null;  // Workspace this job belongs to
  parentJobId: string | null;  // Primary parent job (for iterative prompting lineage)
  parentJobIds: string[];       // All parent job IDs (from job_parents table; for multi-parent merges)
  status: JobStatus;
  prompt: string | null;
  imageUrl: string | null;
  sourceImages: string[] | null; // Actual source image URLs used as input (e.g. 2 URLs for combined edit)
  generateType: GenerateType;
  faceCount: number | null;
  enablePBR: boolean;
  polygonType: PolygonType | null;
  resultGlbUrl: string | null;
  previewImageUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  name: string | null;
  creditsUsed: number;  // Credits consumed for this job (e.g. 10 for 3D, 0 for preview)
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspaceRecord {
  id: string;
  userId: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatRecord {
  id: string;
  userId: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserRecord {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AssetRecord {
  id: string;
  userId: string;
  jobId: string | null;
  type: "model" | "image" | "preview";
  name: string | null;
  fileUrl: string;
  fileSize: number | null;
  mimeType: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}
