import { t } from "../../i18n/index.js";
import {
  DEFAULT_CHART_LINK_GROUP_ID,
  type ChartLinkGroup,
} from "./chartWorkspaceTypes.js";

const DEFAULT_CONTROLLER_NAMES = new Set(["Controller group", "主控组"]);
const NUMBERED_GROUP_NAME = /^(?:Link group|联动组)\s+(\d+)$/;

export function chartLinkGroupDisplayName(
  group: Pick<ChartLinkGroup, "id" | "name">,
): string {
  if (
    group.id === DEFAULT_CHART_LINK_GROUP_ID
    && DEFAULT_CONTROLLER_NAMES.has(group.name)
  ) {
    return t("workspace.linkGroup.controller");
  }
  const numbered = NUMBERED_GROUP_NAME.exec(group.name);
  return numbered
    ? t("workspace.linkGroup.numbered", { count: Number(numbered[1]) })
    : group.name;
}
