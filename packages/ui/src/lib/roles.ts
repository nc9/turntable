import type { Whoami } from "@/api/types";

export type Role = Whoami["role"];

// Same ladder as the API: reader/viewer 1, operator/member 2, release_operator 3, admin 4, owner 5.
const RANK: Record<Role, number> = {
  reader: 1,
  viewer: 1,
  operator: 2,
  member: 2,
  release_operator: 3,
  admin: 4,
  owner: 5,
};

const LABEL: Record<Role, string> = {
  reader: "reader",
  viewer: "viewer",
  operator: "operator",
  member: "member",
  release_operator: "release operator",
  admin: "admin",
  owner: "owner",
};

export function roleLabel(role: Role): string {
  return LABEL[role];
}

export function meetsRole(have: Role, need: Role): boolean {
  return RANK[have] >= RANK[need];
}
