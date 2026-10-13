import { isPermission, PERMISSIONS } from './permissions';
import { SYSTEM_ROLES } from './system-roles';

describe('SYSTEM_ROLES', () => {
  it("n'utilise que des permissions du catalogue", () => {
    for (const role of SYSTEM_ROLES) {
      for (const p of role.permissions) expect(isPermission(p)).toBe(true);
    }
  });

  it('le Recteur a toutes les permissions administratives', () => {
    const rector = SYSTEM_ROLES.find((r) => r.key === 'rector')!;
    expect(rector.permissions).toEqual(PERMISSIONS.filter((p) => !p.startsWith('self:')));
  });

  it("seul le SG-Acad (et le Recteur) publie les notes", () => {
    const publishers = SYSTEM_ROLES.filter((r) => r.permissions.includes('grades:publish')).map((r) => r.key);
    expect(publishers.sort()).toEqual(['rector', 'sg_academic']);
  });

  it("un professeur soumet mais ne publie pas", () => {
    const professor = SYSTEM_ROLES.find((r) => r.key === 'professor')!;
    expect(professor.permissions).toContain('grades:submit');
    expect(professor.permissions).not.toContain('grades:publish');
  });
});
