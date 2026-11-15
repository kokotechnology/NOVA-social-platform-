export const protectedAccountRoles = ['MODERATOR', 'ADMIN', 'SUPER_ADMIN'] as const;

export function isProtectedAccountRole(role: string | null | undefined) {
  return protectedAccountRoles.some((protectedRole) => protectedRole === role);
}

export function canViewProtectedAccounts(role: string | null | undefined) {
  return isProtectedAccountRole(role);
}
