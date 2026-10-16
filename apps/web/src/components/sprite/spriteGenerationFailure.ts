export function spriteGenerationFailureMessage(error: string): string {
  if (/\b(?:524|502|503|504)\b|timed?\s*out|timeout|network|ECONN/i.test(error))
    return "The image service did not respond successfully. Review the plan and try again later.";
  if (/\b429\b|rate.?limit|quota|credit|balance/i.test(error))
    return "The image provider's usage or request limit was reached. Check the provider before retrying.";
  if (/\b(?:401|403)\b|unauthori[sz]ed|authentication|api.?key/i.test(error))
    return "The image provider could not authorize the request. Check its settings before retrying.";
  if (/parameter|unsupported|invalid.*(?:size|quality|format|background)|\b400\b/i.test(error))
    return "The image provider rejected a setting. Modify the plan before trying again.";
  return "Generation failed. Review the plan before trying again.";
}
