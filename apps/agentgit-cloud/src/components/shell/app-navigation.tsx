import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Bell,
  FolderGit2,
  Gauge,
  GitPullRequestArrow,
  LayoutDashboard,
  RadioTower,
  Receipt,
  Settings,
  ShieldCheck,
  Users,
  Wrench,
} from "lucide-react";

import { authenticatedRoutes } from "@/lib/navigation/routes";

export type AppNavItem = {
  href: string;
  icon: LucideIcon;
  label: string;
  minRole: "member" | "admin" | "owner";
  section: "Operations" | "Governance" | "Settings";
};

export const appNavigationItems: AppNavItem[] = [
  {
    href: authenticatedRoutes.dashboard,
    icon: LayoutDashboard,
    label: "Dashboard",
    minRole: "member",
    section: "Operations",
  },
  {
    href: authenticatedRoutes.repositories,
    icon: FolderGit2,
    label: "Repositories",
    minRole: "member",
    section: "Operations",
  },
  {
    href: authenticatedRoutes.approvals,
    icon: GitPullRequestArrow,
    label: "Approvals",
    minRole: "member",
    section: "Operations",
  },
  {
    href: authenticatedRoutes.activity,
    icon: Activity,
    label: "Activity",
    minRole: "member",
    section: "Operations",
  },
  {
    href: authenticatedRoutes.audit,
    icon: ShieldCheck,
    label: "Audit log",
    minRole: "admin",
    section: "Governance",
  },
  {
    href: authenticatedRoutes.calibration,
    icon: Gauge,
    label: "Calibration",
    minRole: "admin",
    section: "Governance",
  },
  {
    href: authenticatedRoutes.connectors,
    icon: RadioTower,
    label: "Connectors",
    minRole: "admin",
    section: "Governance",
  },
  {
    href: authenticatedRoutes.settings,
    icon: Settings,
    label: "Workspace",
    minRole: "admin",
    section: "Settings",
  },
  {
    href: authenticatedRoutes.team,
    icon: Users,
    label: "Team",
    minRole: "admin",
    section: "Settings",
  },
  {
    href: authenticatedRoutes.billing,
    icon: Receipt,
    label: "Billing",
    minRole: "owner",
    section: "Settings",
  },
  {
    href: authenticatedRoutes.integrations,
    icon: Wrench,
    label: "Integrations",
    minRole: "admin",
    section: "Settings",
  },
];

export const shellQuickActions = [
  { category: "Actions", icon: Bell, label: "Open approvals", href: authenticatedRoutes.approvals },
  { category: "Settings", icon: Settings, label: "Open workspace settings", href: authenticatedRoutes.settings },
] as const;
