export interface Branding {
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryColor: string;
  secondaryColor: string;
  hero: Hero;
}

export interface Hero {
  title?: string;
  subtitle?: string;
  imageUrl?: string;
}

export interface Manifest {
  slug: string;
  name: string;
  locale: string;
  branding: Branding | null;
  features: string[];
  auth: { issuer: string };
}

export interface Announcement {
  id: string;
  title: string;
  body: string;
  visibility: 'public' | 'campus';
  publishedAt: string;
}

export interface Homepage {
  hero: Hero;
  faculties: { code: string; name: string }[];
  announcements: Announcement[];
}

export interface Me {
  id: string;
  email: string;
  fullName: string;
  roles: string[];
  permissions: string[];
  grants: { permission: string; scope: { type: string; id: string | null } }[];
}

export type GradesStatus = 'draft' | 'submitted' | 'returned' | 'approved' | 'published';

export interface MyCourse {
  enrollmentId: string;
  offeringId: string;
  courseCode: string;
  courseTitle: string;
  credits: number;
  termCode: string;
  termName: string;
  section: string;
  gradesPublished: boolean;
}

export interface TermGrades {
  termCode: string;
  termName: string;
  average: number | null;
  creditsAttempted: number;
  creditsEarned: number;
  grades: { courseCode: string; courseTitle: string; credits: number; score: number; publishedAt: string }[];
}

export interface TeachingOffering {
  id: string;
  courseCode: string;
  courseTitle: string;
  termCode: string;
  section: string;
  gradesStatus: GradesStatus;
  returnReason: string | null;
  enrolledCount: number;
  gradedCount: number;
}

export interface GradeSheet {
  id: string;
  courseCode: string;
  courseTitle: string;
  credits: number;
  termCode: string;
  termName: string;
  section: string;
  capacity: number | null;
  gradesStatus: GradesStatus;
  returnReason: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  publishedAt: string | null;
  instructors: { id: string; fullName: string; email: string }[];
  roster: { enrollmentId: string; studentId: string; fullName: string; email: string; score: number | null }[];
}

export interface ReviewItem {
  id: string;
  courseCode: string;
  courseTitle: string;
  termCode: string;
  section: string;
  gradesStatus: GradesStatus;
  submittedAt: string | null;
  approvedAt: string | null;
  submittedBy: string | null;
  departmentName: string;
  enrolledCount: number;
}

export type TranscriptStatus = 'requested' | 'validated' | 'rejected';

export interface Transcript {
  id: string;
  status: TranscriptStatus;
  requestedAt: string;
  decidedAt: string | null;
  rejectReason: string | null;
  verificationCode: string | null;
}

export interface TranscriptRequest extends Transcript {
  studentId: string;
  studentName: string;
  studentEmail: string;
}

export interface TranscriptVerification {
  valid: true;
  university: string;
  verificationCode: string;
  studentName: string;
  issuedAt: string;
  creditsEarned: number | null;
  average: number | null;
  contentHash: string;
}
