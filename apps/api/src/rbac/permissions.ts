/**
 * Catalogue des permissions. Le code vérifie toujours une permission, jamais
 * un nom de rôle : une université peut ainsi créer ses propres rôles.
 */
export const PERMISSIONS = [
  // Configuration et pilotage
  'tenant:config:write',
  'tenant:branding:write',
  'audit:read',
  'reports:strategic:read',
  'roles:manage',
  'users:manage',
  // Académique (SG-Acad)
  'academic:structure:read',
  'academic:structure:write',
  'academic:calendar:write',
  'courses:offerings:write',
  'enrollments:override',
  'grades:approve',
  'grades:publish',
  'transcripts:validate',
  // Enseignement (professeurs)
  'courses:materials:write',
  'courses:roster:read',
  'attendance:write',
  'grades:enter',
  'grades:submit',
  // Administration (SG-Admin)
  'staff:manage',
  'fees:structures:write',
  'finance:read',
  'facilities:manage',
  'reports:operational:read',
  // Recherche (SG-Res)
  'research:labs:manage',
  'research:grants:manage',
  'research:publications:manage',
  'research:funding:allocate',
  // Étudiants
  'self:courses:read',
  'self:assignments:submit',
  'self:grades:read',
  'self:transcripts:download',
  'self:payments:write',
  // Commun
  'announcements:read',
  'announcements:write',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}
