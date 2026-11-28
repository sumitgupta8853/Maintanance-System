import { test } from 'node:test';
import assert from 'node:assert/strict';

function makeUser(id, roleName, perms = []) {
  return {
    _id: { toString: () => String(id) },
    role: roleName ? { name: roleName, permissions: perms } : undefined,
  };
}

/** Stub User model whose find().populate() resolves to the given users. */
function stubUserModel(users) {
  return {
    find: () => ({
      populate: () => Promise.resolve(users),
    }),
  };
}

function ticketWith(departmentId, createdBy, assignedTo, assignedBy) {
  return {
    _id: { toString: () => 'ticket-1' },
    ticketNumber: 'TKT-0001',
    subject: 'Test subject',
    departmentId,
    createdBy: createdBy ? { toString: () => String(createdBy) } : undefined,
    assignedTo: assignedTo ? { toString: () => String(assignedTo) } : undefined,
    assignedBy: assignedBy ? { toString: () => String(assignedBy) } : undefined,
  };
}

async function importModule() {
  return await import('../utils/pushNotification.js');
}

test('getDepartmentNotifyUsers returns empty set when no departmentId', async (t) => {
  const { getDepartmentNotifyUsers } = await importModule();
  const result = await getDepartmentNotifyUsers(null, stubUserModel([]));
  assert.deepStrictEqual([...result], []);
});

test('getDepartmentNotifyUsers returns technical_manager and wildcard/view_department users', async (t) => {
  const users = [
    makeUser('u-tm', 'technical_manager'),
    makeUser('u-admin', 'admin', ['*']),
    makeUser('u-view', 'customer_care_manager', ['ticket:view_department']),
    makeUser('u-engineer', 'service_engineer', []), // should be excluded
    makeUser('u-no-role', undefined, []), // should be excluded
  ];
  const { getDepartmentNotifyUsers } = await importModule();
  const result = await getDepartmentNotifyUsers('dept-1', stubUserModel(users));
  const ids = [...result].sort();
  assert.deepStrictEqual(ids, ['u-admin', 'u-tm', 'u-view']);
});

test('ticket_status_updated notifies department technical manager', async (t) => {
  const { resolveNotifyUsers } = await importModule();
  const deptUsers = [makeUser('u-tm', 'technical_manager')];
  const userModel = stubUserModel(deptUsers);

  const ticket = ticketWith('dept-1', 'u-creator', 'u-engineer', 'u-assigner');
  const result = await resolveNotifyUsers(
    ticket,
    'ticket_status_updated',
    'u-assigner',
    userModel
  );

  const ids = [...result].sort();
  // createdBy + assignedTo + department technical manager; actor (assigner) removed
  assert.deepStrictEqual(ids, ['u-creator', 'u-engineer', 'u-tm']);
});

test('ticket_status_updated excludes the actor even if they are a department manager', async (t) => {
  const { resolveNotifyUsers } = await importModule();
  const deptUsers = [makeUser('u-tm', 'technical_manager')];
  const userModel = stubUserModel(deptUsers);

  const ticket = ticketWith('dept-1', 'u-creator', 'u-engineer', 'u-tm');
  const result = await resolveNotifyUsers(
    ticket,
    'ticket_status_updated',
    'u-tm',
    userModel
  );

  const ids = [...result].sort();
  assert.deepStrictEqual(ids, ['u-creator', 'u-engineer']);
});

test('ticket_closed notifies department technical manager', async (t) => {
  const { resolveNotifyUsers } = await importModule();
  const deptUsers = [makeUser('u-tm', 'technical_manager')];
  const userModel = stubUserModel(deptUsers);

  const ticket = ticketWith('dept-1', 'u-creator', 'u-engineer', 'u-assigner');
  const result = await resolveNotifyUsers(ticket, 'ticket_closed', 'u-assigner', userModel);

  const ids = [...result].sort();
  assert.deepStrictEqual(ids, ['u-creator', 'u-engineer', 'u-tm']);
});

test('ticket_closed excludes the actor', async (t) => {
  const { resolveNotifyUsers } = await importModule();
  const deptUsers = [makeUser('u-tm', 'technical_manager')];
  const userModel = stubUserModel(deptUsers);

  const ticket = ticketWith('dept-1', 'u-creator', 'u-tm', 'u-assigner');
  const result = await resolveNotifyUsers(ticket, 'ticket_closed', 'u-tm', userModel);

  const ids = [...result].sort();
  assert.deepStrictEqual(ids, ['u-assigner', 'u-creator']);
});

test('ticket_created still notifies department technical managers (regression)', async (t) => {
  const { resolveNotifyUsers } = await importModule();
  const deptUsers = [makeUser('u-tm', 'technical_manager')];
  const userModel = stubUserModel(deptUsers);

  const ticket = ticketWith('dept-1', 'u-creator', 'u-engineer', 'u-assigner');
  const result = await resolveNotifyUsers(ticket, 'ticket_created', 'u-creator', userModel);

  assert.deepStrictEqual([...result], ['u-tm']);
});

test('deduplicates a user who is both department manager and assignedTo', async (t) => {
  const { resolveNotifyUsers } = await importModule();
  const deptUsers = [makeUser('u-tm', 'technical_manager')];
  const userModel = stubUserModel(deptUsers);

  // assignedTo is the same user as the department technical manager
  const ticket = ticketWith('dept-1', 'u-creator', 'u-tm', 'u-assigner');
  const result = await resolveNotifyUsers(
    ticket,
    'ticket_status_updated',
    'u-assigner',
    userModel
  );

  const ids = [...result].sort();
  assert.deepStrictEqual(ids, ['u-creator', 'u-tm']);
});

test('ticket_status_updated without department still notifies createdBy/assignedTo/assignedBy', async (t) => {
  const { resolveNotifyUsers } = await importModule();
  const userModel = stubUserModel([]);

  const ticket = ticketWith(undefined, 'u-creator', 'u-engineer', 'u-assigner');
  const result = await resolveNotifyUsers(
    ticket,
    'ticket_status_updated',
    'u-engineer',
    userModel
  );

  const ids = [...result].sort();
  assert.deepStrictEqual(ids, ['u-assigner', 'u-creator']);
});

test('ticket_assigned notifies the assigned engineer and department managers, but not the assigning manager', async (t) => {
  const { resolveNotifyUsers } = await importModule();
  const deptUsers = [
    makeUser('u-tm', 'technical_manager'),      // assigning manager
    makeUser('u-other-tm', 'technical_manager'), // other department manager
  ];
  const userModel = stubUserModel(deptUsers);

  const ticket = ticketWith('dept-1', 'u-creator', 'u-engineer', 'u-tm');
  const result = await resolveNotifyUsers(
    ticket,
    'ticket_assigned',
    'u-tm', // actor = assigning technical manager
    userModel
  );

  const ids = [...result].sort();
  // assigned engineer + other department manager; assigning manager excluded
  assert.deepStrictEqual(ids, ['u-engineer', 'u-other-tm']);
});

test('ticket_assigned self-assign notifies department managers but not the self-assigning engineer', async (t) => {
  const { resolveNotifyUsers } = await importModule();
  const deptUsers = [makeUser('u-tm', 'technical_manager')];
  const userModel = stubUserModel(deptUsers);

  // Engineer self-assigns: assignedTo === actorId
  const ticket = ticketWith('dept-1', 'u-creator', 'u-engineer', 'u-engineer');
  const result = await resolveNotifyUsers(
    ticket,
    'ticket_assigned',
    'u-engineer', // actor = the engineer who self-assigned
    userModel
  );

  const ids = [...result].sort();
  // Only department managers; self-assigning engineer excluded
  assert.deepStrictEqual(ids, ['u-tm']);
});

test('ticket_assigned without assignedTo still notifies department managers', async (t) => {
  const { resolveNotifyUsers } = await importModule();
  const deptUsers = [makeUser('u-tm', 'technical_manager')];
  const userModel = stubUserModel(deptUsers);

  const ticket = ticketWith('dept-1', 'u-creator', undefined, 'u-assigner');
  const result = await resolveNotifyUsers(
    ticket,
    'ticket_assigned',
    'u-assigner', // actor is not a department manager
    userModel
  );

  const ids = [...result].sort();
  assert.deepStrictEqual(ids, ['u-tm']);
});
