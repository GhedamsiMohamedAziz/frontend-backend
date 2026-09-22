import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  can,
  capabilitiesFor,
  effectiveProjectRole,
  type AccessContext,
} from '../src/permissions.js';

const ctx = (orgRole: AccessContext['orgRole'], projectRole: AccessContext['projectRole']) => ({
  orgRole,
  projectRole,
});

describe('effectiveProjectRole', () => {
  it('promotes org owners and admins to project admin', () => {
    expect(effectiveProjectRole(ctx('owner', null))).toBe('admin');
    expect(effectiveProjectRole(ctx('admin', 'viewer'))).toBe('admin');
  });

  it('does not promote ordinary org members', () => {
    expect(effectiveProjectRole(ctx('member', 'qa'))).toBe('qa');
    expect(effectiveProjectRole(ctx('member', null))).toBeNull();
  });
});

describe('can', () => {
  it('denies everything without a role — including read', () => {
    for (const capability of CAPABILITIES) {
      expect(can(ctx(null, null), capability)).toBe(false);
      expect(can(ctx('member', null), capability)).toBe(false);
    }
  });

  it('gives a viewer read and nothing else', () => {
    expect(capabilitiesFor(ctx('member', 'viewer'))).toEqual(['project:read']);
  });

  it('lets QA act on results but not configure the project', () => {
    const qa = ctx('member', 'qa');
    expect(can(qa, 'triage:write')).toBe(true);
    expect(can(qa, 'run:trigger')).toBe(true);
    expect(can(qa, 'test:quarantine')).toBe(true);
    expect(can(qa, 'workflow:manage')).toBe(false);
    expect(can(qa, 'token:manage')).toBe(false);
  });

  it('lets a maintainer configure runs but not manage members or tokens', () => {
    const maintainer = ctx('member', 'maintainer');
    expect(can(maintainer, 'workflow:manage')).toBe(true);
    expect(can(maintainer, 'schedule:manage')).toBe(true);
    expect(can(maintainer, 'gate:manage')).toBe(true);
    expect(can(maintainer, 'member:manage')).toBe(false);
    expect(can(maintainer, 'retention:manage')).toBe(false);
  });

  it('grants a project admin every capability', () => {
    expect(capabilitiesFor(ctx('member', 'admin'))).toEqual([...CAPABILITIES]);
  });

  it('is monotonic: a higher role never loses a capability', () => {
    const ladder = ['viewer', 'qa', 'maintainer', 'admin'] as const;
    for (let i = 1; i < ladder.length; i += 1) {
      const lower = capabilitiesFor(ctx('member', ladder[i - 1]!));
      const higher = capabilitiesFor(ctx('member', ladder[i]!));
      for (const capability of lower) expect(higher).toContain(capability);
    }
  });
});
