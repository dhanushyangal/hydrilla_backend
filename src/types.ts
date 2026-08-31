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
  | "Combined"
  | "CodeSculpt"
  | "Water";

export type JobEngine = "trilles" | "hunyuan" | "code_sculpt" | "water";
export type JobResultKind = "glb" | "three_factory";

export interface CreateJobInput {
  prompt?: string;
  imageUrl?: string;
  imageBase64?: string;
  multiViewImages?: Array<{ viewType: "left" | "right" | "back"; viewImageUrl: string }>;
  generateType?: GenerateType;
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
  enablePBR: boolean; // legacy field; always true (column dropped)
  resultGlbUrl: string | null;
  previewImageUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  creditsUsed: number;  // Credits consumed for this job (e.g. 10 for 3D, 0 for preview)
  engine?: JobEngine | string | null;
  resultKind?: JobResultKind | string | null;
  llmModel?: string | null;
  llmProvider?: string | null;
  factoryCode?: string | null;
  sculptPass?: string | null;
  sculptSpec?: Record<string, unknown> | null;
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

export type BlogPostStatus = "draft" | "published";

export interface BlogPostRecord {
  id: string;
  title: string;
  headline: string | null;
  slug: string;
  excerpt: string;
  content: string;
  coverImage: string | null;
  category: string;
  author: string;
  status: BlogPostStatus;
  publishedAt: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  seoImage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BlogPostInput {
  title: string;
  headline?: string | null;
  slug: string;
  excerpt: string;
  content: string;
  coverImage?: string | null;
  category: string;
  author: string;
  status: BlogPostStatus;
  publishedAt?: string | null;
  seoTitle?: string | null;
  seoDescription?: string | null;
  seoImage?: string | null;
}
