/**
 * xml — reusable XML escaping utilities.
 *
 * Extracted from render.ts and supervisor.ts to eliminate duplicate
 * implementations that had drifted apart.
 */

/**
 * Escape a string for use in an XML attribute value.
 * Handles all five XML special characters: & " ' < >
 */
export function escapeXmlAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Escape a string for use in XML element body content.
 * Escapes only the structural characters (& < >) plus CDATA-closing
 * sequence (]]>) which would break XML parsing if left unescaped.
 */
export function escapeXmlBody(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("]]>", "]]&gt;");
}
