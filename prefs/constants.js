/** Shared constants for the preferences window. */

export const SCALE_UPDATE_TIMEOUT = 500
/** When true, hide low-value / conflicting prefs in the settings UI. */
export const DISABLE_CONFLICTING_AND_GNOME_PREFS = true
export const SIMPLIFY_PREFS = DISABLE_CONFLICTING_AND_GNOME_PREFS

export const SCHEMA_PATH = '/org/gnome/shell/extensions/dash-to-workspaces/'

/** Entire preference groups to hide in simplified mode. */
export const HIDDEN_PREF_GROUPS = [
  'action_group_hotkey',
  'behavior_group_hover',
  'behavior_group_isolate',
  'behavior_group_overview',
  'style_group_global',
  'style_group_dynamic_trans3',
  'style_group_dynamic_trans4',
  'action_appicons_group',
  'context_menu_group',
  'position_group_on_monitor3',
]

/** Individual widgets whose parent row should be hidden. */
export const HIDDEN_PREF_ROW_WIDGETS = [
  'show_favorite_switch',
  'multimon_multi_show_favorites_switch',
  'panel_anchor_label',
  'workspace_preview_position_combo',
  'workspace_preview_name_position_combo',
  'workspace_preview_app_icons_stable_order_switch',
  'workspace_preview_avoid_dash_to_panel_switch',
  'dot_style_options_button',
  'dot_style_unfocused_combo',
  'animate_appicon_hover_switch',
  'animate_appicon_hover_button',
  'highlight_appicon_hover_switch',
  'highlight_appicon_hover_button',
]

/** Intellihide sub-dialog rows to hide (advanced / edge-case). */
export const HIDDEN_INTELLIHIDE_ROWS = [
  'intellihide_behaviour_options',
  'intellihide_revealed_hover_options',
  'intellihide_use_pressure_options2',
  'intellihide_use_pressure_options3',
  'grid_intellihide_only_secondary',
  'grid_intellihide_persist_state',
  'intellihide_use_pointer_limit_button',
]

/** Intellihide sub-dialog rows located by child widget id. */
export const HIDDEN_INTELLIHIDE_ROW_WIDGETS = [
  'intellihide_toggle_entry',
  'intellihide_show_on_notification_switch',
  'intellihide_reveal_delay_spinbutton',
  'intellihide_enable_start_delay_spinbutton',
]

export const DEFAULT_PANEL_SIZES = [128, 96, 64, 48, 32, 22]
export const DEFAULT_FONT_SIZES = [96, 64, 48, 32, 24, 16, 0]
export const DEFAULT_MARGIN_SIZES = [32, 24, 16, 12, 8, 4, 0]
export const DEFAULT_PADDING_SIZES = [32, 24, 16, 12, 8, 4, 0, -1]
export const LENGTH_MARKS = [100, 90, 80, 70, 60, 50, 40, 30, 20]
export const MAX_WINDOW_INDICATOR = 4

/** Settings that require tearing down and recreating all panels. */
export const PANEL_FULL_RESET_KEYS = [
  'primary-monitor',
  'multi-monitors',
  'isolate-monitors',
  'panel-positions',
  'panel-lengths',
  'panel-anchors',
  'stockgs-keep-top-panel',
]

/** Settings that only need geometry refresh on existing panels. */
export const PANEL_GEOMETRY_REFRESH_KEYS = [
  'panel-sizes',
  'panel-side-margins',
  'panel-top-bottom-margins',
  'panel-side-padding',
  'panel-top-bottom-padding',
  'workspace-preview-width',
  'workspace-preview-display-mode',
  'workspace-preview-position-outside',
]
