/**
 * Menus de l'espace connecté, construits à partir des permissions de
 * l'utilisateur (et non de son rôle). Même principe que l'app mobile :
 * l'API revérifie toujours les droits, le menu n'est qu'un confort.
 */
export interface NavItem {
  key: string;
  label: string;
  href: string;
  /** L'entrée s'affiche si l'utilisateur a au moins une de ces permissions. */
  anyOf: string[];
  /** Module pas encore livré : affiché comme « bientôt ». */
  upcoming?: boolean;
}

export interface NavSection {
  key: string;
  label: string;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    key: 'student',
    label: 'Mes études',
    items: [
      { key: 'courses', label: 'Mes cours', href: '/espace/cours', anyOf: ['self:courses:read'] },
      { key: 'assignments', label: 'Devoirs', href: '/espace/devoirs', anyOf: ['self:assignments:submit'], upcoming: true },
      { key: 'grades', label: 'Notes et relevés', href: '/espace/notes', anyOf: ['self:grades:read'] },
      { key: 'payments', label: 'Paiements', href: '/espace/paiements', anyOf: ['self:payments:write'], upcoming: true },
    ],
  },
  {
    key: 'teaching',
    label: 'Enseignement',
    items: [
      { key: 'my-courses', label: 'Mes enseignements', href: '/espace/enseignements', anyOf: ['courses:materials:write'], upcoming: true },
      { key: 'grading', label: 'Notation', href: '/espace/notation', anyOf: ['grades:enter'] },
      { key: 'attendance', label: 'Présences', href: '/espace/presences', anyOf: ['attendance:write'], upcoming: true },
    ],
  },
  {
    key: 'administration',
    label: 'Administration',
    items: [
      { key: 'structure', label: 'Facultés et départements', href: '/espace/structure', anyOf: ['academic:structure:write'], upcoming: true },
      { key: 'grade-approval', label: 'Validation des notes', href: '/espace/validation-notes', anyOf: ['grades:approve', 'grades:publish'] },
      { key: 'finance', label: 'Finances', href: '/espace/finances', anyOf: ['finance:read'], upcoming: true },
      { key: 'research', label: 'Recherche', href: '/espace/recherche', anyOf: ['research:labs:manage'], upcoming: true },
      { key: 'audit', label: "Journal d'audit", href: '/espace/audit', anyOf: ['audit:read'], upcoming: true },
    ],
  },
];

export function navFor(permissions: readonly string[]): NavSection[] {
  const owned = new Set(permissions);
  return NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => item.anyOf.some((p) => owned.has(p))),
  })).filter((section) => section.items.length > 0);
}
