import { z } from 'zod';
import {
  emailSchema,
  idSchema,
  newPasswordSchema,
  passwordSchema,
  usernameSchema,
} from './common.js';

export const loginSchema = z.object({
  identifier: z.string().trim().min(1, 'Enter your email or username').max(254),
  password: z.string().min(1, 'Enter your password').max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password').max(200),
    newPassword: newPasswordSchema,
    confirmPassword: z.string().min(1),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })
  .refine((data) => data.currentPassword !== data.newPassword, {
    message: 'New password must be different from the current password',
    path: ['newPassword'],
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const forgotPasswordSchema = z.object({
  email: emailSchema,
});
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z
  .object({
    token: z.string().min(20).max(400),
    newPassword: newPasswordSchema,
    confirmPassword: z.string().min(1),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const updateProfileSchema = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  phone: z.string().trim().max(32).optional().nullable(),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

/* Admin-side user management ------------------------------------------------ */

export const createUserSchema = z.object({
  email: emailSchema,
  fullName: z.string().trim().min(2, 'Enter the full name').max(120),
  username: usernameSchema.optional().nullable(),
  role: z.enum(['admin', 'teacher', 'reviewer']),
  employeeCode: z.string().trim().max(40).optional().nullable(),
  phone: z.string().trim().max(32).optional().nullable(),
  /** Supplied by admins when creating another user; defaults to a strong random value. */
  password: passwordSchema.optional(),
  mustChangePassword: z.boolean().default(true),
  sendInvite: z.boolean().default(false),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  role: z.enum(['admin', 'teacher', 'reviewer']).optional(),
  employeeCode: z.string().trim().max(40).optional().nullable(),
  phone: z.string().trim().max(32).optional().nullable(),
  username: usernameSchema.optional().nullable(),
  status: z.enum(['active', 'inactive']).optional(),
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const listUsersSchema = z
  .object({
    search: z.string().trim().max(120).optional(),
    role: z.enum(['admin', 'teacher', 'reviewer']).optional(),
    status: z.enum(['active', 'inactive']).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .optional()
  .default({});
export type ListUsersInput = z.infer<typeof listUsersSchema>;

export const adminResetPasswordSchema = z.object({
  newPassword: newPasswordSchema.optional(),
  mustChangePassword: z.boolean().default(true),
  reason: z.string().trim().min(3).max(500).optional(),
});
export type AdminResetPasswordInput = z.infer<typeof adminResetPasswordSchema>;

export const sessionIdSchema = z.object({ id: idSchema });