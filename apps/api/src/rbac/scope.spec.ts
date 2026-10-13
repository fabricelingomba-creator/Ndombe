import { Grant, grantsAllow, UNIVERSITY_SCOPE } from './scope';

const faculty = { type: 'faculty', id: 'fac-sciences' } as const;
const department = { type: 'department', id: 'dep-maths' } as const;
const otherFaculty = { type: 'faculty', id: 'fac-droit' } as const;

describe('grantsAllow', () => {
  const facultyGrant: Grant[] = [{ permission: 'grades:approve', scope: faculty }];

  it('autorise sur la portée exacte', () => {
    expect(grantsAllow(facultyGrant, 'grades:approve', [faculty, UNIVERSITY_SCOPE])).toBe(true);
  });

  it("autorise sur un département de la faculté (portée héritée)", () => {
    expect(grantsAllow(facultyGrant, 'grades:approve', [department, faculty, UNIVERSITY_SCOPE])).toBe(true);
  });

  it("refuse sur une autre faculté", () => {
    expect(grantsAllow(facultyGrant, 'grades:approve', [otherFaculty, UNIVERSITY_SCOPE])).toBe(false);
  });

  it("refuse une action à l'échelle de l'université", () => {
    expect(grantsAllow(facultyGrant, 'grades:approve', [UNIVERSITY_SCOPE])).toBe(false);
  });

  it('refuse une autre permission', () => {
    expect(grantsAllow(facultyGrant, 'grades:publish', [faculty, UNIVERSITY_SCOPE])).toBe(false);
  });

  it("la portée université couvre tout", () => {
    const grants: Grant[] = [{ permission: 'grades:publish', scope: UNIVERSITY_SCOPE }];
    expect(grantsAllow(grants, 'grades:publish', [department, faculty, UNIVERSITY_SCOPE])).toBe(true);
  });
});
