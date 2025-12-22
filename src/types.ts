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

