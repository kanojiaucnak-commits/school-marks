/**
 * Domain types shared between the React frontend and the Postgres schema.
 * These mirror the CHECK constraints in `supabase/migrations/0001_schema.sql`.
 */

import type {
  ExportFormat,
  Gender,
  MarkSource,
  MarkStatus,
  OcrMatchMethod,
  OcrStatus,
  Role,
  StudentStatus,
  SubmissionStatus,
  UserStatus,
  ImportStatus,
} from './constants.js';
import type { Permission } from './permissions.js';

/* -------------------------------------------------------------------------- */
/* API envelope                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The `{success, data}` / `{success, error}` shape returned by Supabase Edge
 * Functions.
 *
 * PostgREST responses are NOT wrapped in this: they return the row array or a
 * `{code, message, details, hint}` error, handled by `camel()` and `QueryError` in
 * the frontend. The envelope survives only because the Edge Functions have to
 * return several kinds of payload — rows, generated files, signed URLs — and one
 * uniform shape keeps the client's unwrapping in a single place.
 */
export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}

export interface ApiFailure {
  success: false;
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'MARK_OUT_OF_RANGE'
  | 'MARK_INVALID'
  | 'DUPLICATE_MARKS'
  | 'SUBMISSION_LOCKED'
  | 'SUBMISSION_NOT_EDITABLE'
  | 'INVALID_TRANSITION'
  | 'REASON_REQUIRED'
  | 'OCR_NOT_COMPLETED'
  | 'OCR_MATCH_AMBIGUOUS'
  | 'OCR_LOW_CONFIDENCE'
  | 'FILE_TOO_LARGE'
  | 'FILE_TYPE_NOT_ALLOWED'
  | 'FILE_CORRUPT'
  | 'RATE_LIMITED'
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_LOCKED'
  | 'ACCOUNT_INACTIVE'
  | 'CSRF_FAILED'
  | 'EMAIL_IN_USE'
  | 'USERNAME_IN_USE'
  | 'IMPORT_VALIDATION_FAILED'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

/* -------------------------------------------------------------------------- */
/* Auth                                                                        */
/* -------------------------------------------------------------------------- */

export interface CurrentUser {
  id: string;
  email: string;
  fullName: string;
  username: string | null;
  role: Role;
  employeeCode: string | null;
  phone: string | null;
  status: UserStatus;
  permissions: Permission[];
  mustChangePassword: boolean;
  lastLoginAt: string | null;
}

export interface LoginRequest {
  identifier: string;
  password: string;
}

export interface LoginResponse {
  user: CurrentUser;
  csrfToken: string;
}

export interface SessionInfo {
  id: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

/* -------------------------------------------------------------------------- */
/* Users                                                                       */
/* -------------------------------------------------------------------------- */

export interface User {
  id: string;
  email: string;
  fullName: string;
  username: string | null;
  role: Role;
  employeeCode: string | null;
  phone: string | null;
  status: UserStatus;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserListItem extends User {
  assignedClassCount: number;
}

/* -------------------------------------------------------------------------- */
/* Academic structure                                                         */
/* -------------------------------------------------------------------------- */

export interface AcademicYear {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  isCurrent: boolean;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export interface ClassRecord {
  id: string;
  academicYearId: string;
  name: string;
  level: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface Section {
  id: string;
  classId: string;
  name: string;
  /** Clerk user id of the teacher responsible for all marks in this section. */
  classTeacherId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Subject {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isElective: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Exam {
  id: string;
  academicYearId: string;
  name: string;
  maxMarks: number;
  weightage: number;
  examDate: string | null;
  status: 'scheduled' | 'ongoing' | 'completed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
}

/** Joined view used heavily by the marks-entry selectors. */
export interface ClassSectionRef {
  classId: string;
  className: string;
  sectionId: string;
  sectionName: string;
  academicYearId: string;
  academicYearName: string;
  label: string;
  studentCount: number;
}

export interface TeacherAssignment {
  id: string;
  teacherId: string;
  teacherName?: string;
  teacherEmail?: string;
  academicYearId: string;
  classId: string;
  className?: string;
  sectionId: string;
  sectionName?: string;
  subjectId: string;
  subjectName?: string;
  subjectCode?: string;
  createdAt: string;
}

/* -------------------------------------------------------------------------- */
/* Students                                                                    */
/* -------------------------------------------------------------------------- */

export interface Student {
  id: string;
  studentNumber: string;
  admissionNumber: string | null;
  rollNumber: number | null;
  fullName: string;
  dateOfBirth: string | null;
  gender: Gender | null;
  classId: string;
  className?: string;
  sectionId: string;
  sectionName?: string;
  academicYearId: string;
  academicYearName?: string;
  guardianName: string | null;
  guardianPhone: string | null;
  guardianEmail: string | null;
  address: string | null;
  status: StudentStatus;
  createdAt: string;
  updatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Grading                                                                     */
/* -------------------------------------------------------------------------- */

export interface GradingRule {
  id: string;
  schemeId: string;
  grade: string;
  minPercentage: number;
  maxPercentage: number;
  gradePoint: number | null;
  isPass: boolean;
  sortOrder: number;
}

export interface GradingScheme {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  rules: GradingRule[];
  createdAt: string;
  updatedAt: string;
}

export interface GradeResult {
  percentage: number | null;
  grade: string | null;
  gradePoint: number | null;
  isPass: boolean | null;
}

/* -------------------------------------------------------------------------- */
/* Marks                                                                       */
/* -------------------------------------------------------------------------- */

export interface Mark {
  id: string;
  studentId: string;
  studentNumber?: string;
  studentName?: string;
  rollNumber?: number | null;
  subjectId: string;
  examId: string;
  academicYearId: string;
  maxMarks: number;
  marksObtained: number | null;
  status: MarkStatus;
  percentage: number | null;
  grade: string | null;
  gradePoint: number | null;
  isPass: boolean | null;
  remarks: string | null;
  source: MarkSource;
  enteredBy: string;
  enteredByName?: string;
  ocrDocumentId: string | null;
  updatedAt: string;
}

/** One editable row in the marks-entry grid. */
export interface MarkEntryRow {
  studentId: string;
  studentNumber: string;
  rollNumber: number | null;
  fullName: string;
  markId: string | null;
  maxMarks: number;
  marksObtained: number | null;
  status: MarkStatus;
  grade: string | null;
  remarks: string | null;
  source: MarkSource | null;
  /** Set when the row exists but belongs to a submission that is no longer editable. */
  locked: boolean;
  /** Populated by the server when the value fails validation. */
  validationError?: string;
}

export interface MarksGridResponse {
  academicYearId: string;
  classId: string;
  sectionId: string;
  subjectId: string;
  examId: string;
  maxMarks: number;
  /** True when `maxMarks` comes from a per-sheet override rather than the exam default. */
  hasSheetOverride?: boolean;
  submission: MarkSubmission | null;
  rows: MarkEntryRow[];
  editable: boolean;
}

export interface MarkSubmission {
  id: string;
  academicYearId: string;
  classId: string;
  className?: string;
  sectionId: string;
  sectionName?: string;
  subjectId: string;
  subjectName?: string;
  subjectCode?: string;
  examId: string;
  examName?: string;
  teacherId: string;
  teacherName?: string;
  teacherEmail?: string;
  status: SubmissionStatus;
  totalStudents: number;
  enteredCount: number;
  averageMarks: number | null;
  submittedAt: string | null;
  approvedAt: string | null;
  lockedAt: string | null;
  reviewedBy: string | null;
  reviewComments: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* OCR                                                                         */
/* -------------------------------------------------------------------------- */

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  page: number;
}

export interface OcrResultRow {
  id: string;
  documentId: string;
  lineIndex: number;
  rawText: string | null;
  detectedIdentifier: string | null;
  detectedName: string | null;
  detectedMarks: string | null;
  confidence: number | null;
  bbox: BoundingBox | null;
  matchedStudentId: string | null;
  matchedStudentName: string | null;
  matchedStudentNumber: string | null;
  matchedRollNumber: number | null;
  matchMethod: OcrMatchMethod;
  matchConfidence: number | null;
  /** Ambiguous candidates the teacher must choose between. Never auto-assigned. */
  candidates: StudentMatchCandidate[];
  correctedMarks: string | null;
  correctedStatus: MarkStatus | null;
  remarks: string | null;
  verified: boolean;
  reviewedAt: string | null;
}

export interface StudentMatchCandidate {
  studentId: string;
  studentNumber: string;
  fullName: string;
  rollNumber: number | null;
  confidence: number;
}

export interface OcrDocument {
  id: string;
  uploadedBy: string;
  uploadedByName?: string;
  academicYearId: string;
  classId: string;
  sectionId: string;
  subjectId: string;
  examId: string;
  originalFilename: string;
  contentType: string;
  sizeBytes: number;
  pageCount: number | null;
  provider: string;
  status: OcrStatus;
  errorMessage: string | null;
  overallConfidence: number | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Subject the sheet was uploaded against, from the `subjects` join. The D1
   * repository never selected it, which is why OcrReviewPage rendered an empty
   * string here; the Postgres view provides it.
   */
  subjectName?: string;
  results?: OcrResultRow[];
  resultCount?: number;
}

/* -------------------------------------------------------------------------- */
/* Audit & notifications                                                       */
/* -------------------------------------------------------------------------- */

export interface AuditLogEntry {
  id: string;
  userId: string | null;
  userEmail: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  oldValue: unknown;
  newValue: unknown;
  reason: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface Notification {
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  data: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

export interface AppNotification extends Notification {
  unread: boolean;
}

/* -------------------------------------------------------------------------- */
/* Reports                                                                     */
/* -------------------------------------------------------------------------- */

export interface StudentReportRow {
  subjectId: string;
  subjectName: string;
  subjectCode: string;
  examId: string;
  examName: string;
  maxMarks: number;
  marksObtained: number | null;
  status: MarkStatus;
  percentage: number | null;
  grade: string | null;
  gradePoint: number | null;
  isPass: boolean | null;
  totalObtained: number | null;
  totalMaximum: number;
  overallPercentage: number | null;
  overallGrade: string | null;
  isPassOverall: boolean | null;
  remarks: string | null;
}

export interface StudentReport {
  student: Student;
  academicYear: AcademicYear;
  scheme: GradingScheme | null;
  generatedAt: string;
  rows: StudentReportRow[];
}

export interface ClassReportRow {
  studentId: string;
  studentNumber: string;
  rollNumber: number | null;
  fullName: string;
  subjects: Array<{
    subjectId: string;
    subjectName: string;
    marksObtained: number | null;
    maxMarks: number;
    status: MarkStatus;
    percentage: number | null;
    grade: string | null;
  }>;
  totalObtained: number | null;
  totalMaximum: number;
  percentage: number | null;
  grade: string | null;
  isPass: boolean | null;
  rank: number | null;
}

export interface ClassReport {
  classRecord: ClassRecord;
  section: Section;
  academicYear: AcademicYear;
  subjectIds: string[];
  scheme: GradingScheme | null;
  generatedAt: string;
  rows: ClassReportRow[];
  subjectAverages: Array<{ subjectId: string; subjectName: string; average: number | null }>;
}

export interface SubjectReport {
  subject: Subject;
  exam: Exam;
  section: Section;
  scheme: GradingScheme | null;
  generatedAt: string;
  studentCount: number;
  presentCount: number;
  absentCount: number;
  averageMarks: number | null;
  highestMarks: number | null;
  highestStudent: string | null;
  lowestMarks: number | null;
  lowestStudent: string | null;
  passCount: number;
  failCount: number;
  passPercentage: number;
  failPercentage: number;
  gradeDistribution: Array<{ grade: string; count: number; percentage: number }>;
  rows: Array<{
    studentId: string;
    studentNumber: string;
    rollNumber: number | null;
    fullName: string;
    marksObtained: number | null;
    status: MarkStatus;
    percentage: number | null;
    grade: string | null;
    isPass: boolean | null;
  }>;
}

export interface SubmissionReportRow {
  submissionId: string;
  teacherName: string;
  teacherEmail: string;
  className: string;
  sectionName: string;
  subjectName: string;
  subjectCode: string;
  examName: string;
  status: SubmissionStatus;
  totalStudents: number;
  enteredCount: number;
  averageMarks: number | null;
  submittedAt: string | null;
  approvedAt: string | null;
  lockedAt: string | null;
  reviewComments: string | null;
}

/* -------------------------------------------------------------------------- */
/* Import / export                                                             */
/* -------------------------------------------------------------------------- */

export interface ImportValidationError {
  row: number;
  field: string;
  value: string;
  message: string;
}

export interface ImportPreviewRow {
  /** 1-based source row, including the header, so it matches the spreadsheet. */
  row: number;
  raw: Record<string, string>;
  parsed: Partial<Student> | null;
  errors: ImportValidationError[];
  existingStudentId: string | null;
}

export interface ImportPreview {
  batchId: string;
  filename: string;
  status: ImportStatus;
  totalRows: number;
  /**
   * The first slice of rows, not necessarily all of them — the function caps this
   * so a 5000-row file does not become megabytes of JSON in one response. The
   * counts below are the true totals.
   */
  rows: ImportPreviewRow[];
  validRowCount: number;
  errorRowCount: number;
  canImport: boolean;
  /** True when `rows` is shorter than `totalRows`. */
  truncated: boolean;
  /** Where the students will be enrolled. Echoed back so the commit cannot disagree. */
  academicYearId: string;
  classId: string;
  sectionId: string;
  message: string;
}

export interface ImportResult {
  batchId: string;
  created: number;
  updated: number;
  skipped: number;
  errors: ImportValidationError[];
  message: string;
}

export interface ExportJob {
  id: string;
  requestedBy: string;
  kind: string;
  format: ExportFormat;
  params: Record<string, unknown> | null;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  /** Present only when COMPLETED. */
  downloadUrl?: string;
}

/* -------------------------------------------------------------------------- */
/* Dashboards                                                                  */
/* -------------------------------------------------------------------------- */

export interface TeacherDashboard {
  assignedClassCount: number;
  assignedSubjectCount: number;
  assignedStudentCount: number;
  draftSheets: number;
  submittedSheets: number;
  approvedSheets: number;
  returnedSheets: number;
  pendingOcrReviews: number;
  processingOcrDocuments: number;
  recentSubmissions: MarkSubmission[];
  pendingActions: Array<{
    submissionId: string;
    label: string;
    examName: string;
    subjectName: string;
    sectionName: string;
    enteredCount: number;
    totalStudents: number;
  }>;
}

export interface AdminDashboard {
  totalStudents: number;
  totalTeachers: number;
  totalClasses: number;
  totalSubjects: number;
  totalSections: number;
  pendingSubmissions: number;
  approvedSubmissions: number;
  lockedSubmissions: number;
  returnedSubmissions: number;
  ocrJobsPending: number;
  ocrJobsFailed: number;
  /** Percentage of all submission sheets that have reached APPROVED or LOCKED. */
  completionPercentage: number;
  submissionsByStatus: Array<{ status: SubmissionStatus; count: number }>;
  subjectCoverage: Array<{ subjectName: string; subjectCode: string; sheetCount: number }>;
  gradeDistribution: Array<{ grade: string; count: number }>;
}