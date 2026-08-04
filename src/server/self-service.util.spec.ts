import type { Assignment, Resource, ResourceRequest } from '../app/services/api.service';
import {
  isOwnAssignment,
  pickSelfProfilePatch,
  selfAssignments,
  selfRequests,
  toSelfProfile,
} from './self-service.util';

const assignments: Assignment[] = [
  { id: 'A1', requestId: 'R1', resourceId: '1', assignedHours: 8, status: 'Allocated' },
  { id: 'A2', requestId: 'R2', resourceId: '2', assignedHours: 16, status: 'Allocated' },
  { id: 'A3', requestId: 'R3', resourceId: '1', assignedHours: 4, status: 'Draft' },
];

const requests: ResourceRequest[] = [
  { id: 'R1', name: 'Own one', requiredRole: 'Developer', requiredEffort: 8, staffedEffort: 8, status: 'Fulfilled', skills: [] },
  { id: 'R2', name: 'Someone else', requiredRole: 'Designer', requiredEffort: 16, staffedEffort: 16, status: 'Fulfilled', skills: [] },
  { id: 'R3', name: 'Own two', requiredRole: 'Developer', requiredEffort: 4, staffedEffort: 4, status: 'Fulfilled', skills: [] },
];

describe('self-service collection scope', () => {
  it('returns only assignments owned by the actor resource', () => {
    expect(selfAssignments(assignments, '1').map(item => item.id)).toEqual(['A1', 'A3']);
  });

  it('returns only requests linked to the actor assignments', () => {
    expect(selfRequests(requests, assignments, '1').map(item => item.id)).toEqual(['R1', 'R3']);
  });

  it('rejects another resource assignment for self time entry submission', () => {
    expect(isOwnAssignment(assignments, 'A1', '1')).toBe(true);
    expect(isOwnAssignment(assignments, 'A2', '1')).toBe(false);
    expect(isOwnAssignment(assignments, 'missing', '1')).toBe(false);
  });
});

describe('self-service profile boundary', () => {
  const profile = {
    id: '1',
    name: 'Employee',
    role: 'Developer',
    skills: [],
    projectRoles: [],
    externalExperience: [],
    profilePicture: '',
    resume: '',
    utilization: 80,
    capacity: 40,
    organization: 'Engineering',
    location: 'Rome',
    costRate: 90,
    billRate: 160,
  } as Resource;

  it('does not expose cost and sell rates on the self profile', () => {
    const self = toSelfProfile(profile) as Record<string, unknown>;
    expect(self['costRate']).toBeUndefined();
    expect(self['billRate']).toBeUndefined();
    expect(self['name']).toBe('Employee');
  });

  it('allow-lists employee-editable profile fields only', () => {
    const patch = pickSelfProfilePatch({
      skills: [{ name: 'TypeScript', level: 3 }],
      projectRoles: ['Developer'],
      externalExperience: [],
      profilePicture: 'data:image/png;base64,x',
      resume: 'data:application/pdf;base64,x',
      name: 'Impersonated Name',
      capacity: 1,
      managerId: 'attacker',
      costRate: 0,
      billRate: 0,
      terminationDate: '2026-01-01',
    });

    expect(patch).toEqual({
      skills: [{ name: 'TypeScript', level: 3 }],
      projectRoles: ['Developer'],
      externalExperience: [],
      profilePicture: 'data:image/png;base64,x',
      resume: 'data:application/pdf;base64,x',
    });
  });
});
