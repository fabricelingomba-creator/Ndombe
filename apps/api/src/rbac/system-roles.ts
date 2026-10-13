import { Permission, PERMISSIONS } from './permissions';

export interface SystemRole {
  key: string;
  name: string;
  permissions: readonly Permission[];
}

/** Rôles créés pour chaque nouvelle université (section 3 du cahier des charges). */
export const SYSTEM_ROLES: readonly SystemRole[] = [
  {
    key: 'rector',
    name: 'Recteur / Président',
    permissions: PERMISSIONS.filter((p) => !p.startsWith('self:')),
  },
  {
    key: 'sg_academic',
    name: 'Secrétaire général académique',
    permissions: [
      'academic:structure:read',
      'academic:structure:write',
      'academic:calendar:write',
      'courses:offerings:write',
      'courses:roster:read',
      'enrollments:override',
      'grades:approve',
      'grades:publish',
      'transcripts:validate',
      'announcements:read',
      'announcements:write',
    ],
  },
  {
    key: 'sg_administration',
    name: 'Secrétaire général administratif',
    permissions: [
      'academic:structure:read',
      'staff:manage',
      'users:manage',
      'fees:structures:write',
      'finance:read',
      'facilities:manage',
      'reports:operational:read',
      'announcements:read',
      'announcements:write',
    ],
  },
  {
    key: 'sg_research',
    name: 'Secrétaire général à la recherche',
    permissions: [
      'academic:structure:read',
      'research:labs:manage',
      'research:grants:manage',
      'research:publications:manage',
      'research:funding:allocate',
      'announcements:read',
      'announcements:write',
    ],
  },
  {
    key: 'professor',
    name: 'Professeur',
    permissions: [
      'academic:structure:read',
      'courses:materials:write',
      'courses:roster:read',
      'attendance:write',
      'grades:enter',
      'grades:submit',
      'announcements:read',
      'announcements:write',
    ],
  },
  {
    key: 'student',
    name: 'Étudiant',
    permissions: [
      'self:courses:read',
      'self:assignments:submit',
      'self:grades:read',
      'self:transcripts:download',
      'self:payments:write',
      'announcements:read',
    ],
  },
];
