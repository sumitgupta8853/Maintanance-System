// Build the MongoDB filter per user based on role scope.
// admin ('*')           -> {} (sees all tickets)
// everyone else         -> $or of what their role allows
// export function ticketAccessFilter(user) {
//   if (!user) return { _id: null };

//   // admin holds * and bypasses both layers
//   const permissions = user.role?.permissions || [];
//   if (permissions.includes('*')) {
//     return {};
//   }

//   const roleName = user.role?.name;

//   const or = [];

//   // Everyone: tickets they created
//   or.push({ createdBy: user._id });

//   // Everyone: tickets assigned to them
//   or.push({ assignedTo: user._id });

//   // Manager's own department, or any role's department filter
//   if (user.departmentId) {
//     or.push({ departmentId: user.departmentId });
//   }

//   return { $or: or };
// }

// // Helper to check if a user can see a ticket given its departmentId/assignedTo/createdBy
// export function ticketInScope(user, ticket) {
//   const filter = ticketAccessFilter(user);
//   if (Object.keys(filter).length === 0) return true; // admin sees all

//   // Handle both raw ObjectId and populated document
//   const getId = (val) => (val && val._id ? val._id.toString() : val ? val.toString() : null);

//   if (getId(ticket.createdBy) === user._id.toString()) return true;
//   if (getId(ticket.assignedTo) === user._id.toString()) return true;
//   if (getId(ticket.departmentId) === user.departmentId?.toString()) return true;

//   return false;
// }


// Admin ('*') and roles with 'ticket:all_departments' can see/act on tickets in every department.
export function hasAllAccess(user) {
  const permissions = user?.role?.permissions || [];
  return permissions.includes('*') || permissions.includes('ticket:all_departments');
}

export function ticketAccessFilter(user) {
  if (!user) return { _id: null };

  // admin ('*') and all-department roles bypass the scope filter
  if (hasAllAccess(user)) {
    return {};
  }

  const or = [];

  // Everyone: tickets they created
  or.push({ createdBy: user._id });

  // Everyone: tickets assigned to them
  or.push({ assignedTo: user._id });

  // Manager's own department, or any role's department filter
  if (user.departmentId) {
    or.push({ departmentId: user.departmentId });
  }

  return { $or: or };
}

// Helper to check if a user can see a ticket given its departmentId/assignedTo/createdBy
export function ticketInScope(user, ticket) {
  const filter = ticketAccessFilter(user);
  if (Object.keys(filter).length === 0) return true; // admin / all-department roles see all

  // Handle both raw ObjectId and populated document
  const getId = (val) => (val && val._id ? val._id.toString() : val ? val.toString() : null);

  if (getId(ticket.createdBy) === user._id.toString()) return true;
  if (getId(ticket.assignedTo) === user._id.toString()) return true;
  if (getId(ticket.departmentId) === user.departmentId?.toString()) return true;

  return false;
}