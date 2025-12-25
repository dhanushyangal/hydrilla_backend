export type JobStatus = "WAIT" | "RUN" | "FAIL" | "DONE";

export type GenerateType = "Normal" | "LowPoly" | "Geometry" | "Sketch";

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
  status: JobStatus;
  prompt: string | null;
  imageUrl: string | null;
  generateType: GenerateType;
  faceCount: number | null;
  enablePBR: boolean;
  polygonType: PolygonType | null;
  resultGlbUrl: string | null;
  previewImageUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
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
