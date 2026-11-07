/**
 * Controlled synonym groups for preparation steps and reagents.
 *
 * Only true translation/notation equivalents belong here. Related but distinct processes
 * (annealing vs calcination, nitrate vs nitrate hexahydrate) are deliberately kept apart:
 * expanding them would silently change the meaning of a filter.
 */

const STEP_GROUPS: string[][] = [
  ['annealing', 'anneal', '退火', '退火处理'],
  ['calcination', 'calcine', 'calcined', '煅烧', '焙烧'],
  ['sintering', 'sinter', 'sintered', '烧结'],
  ['drying', 'dry', 'dried', '干燥', '烘干'],
  ['freeze-drying', 'freeze drying', 'lyophilization', '冷冻干燥', '冻干'],
  ['spray-drying', 'spray drying', '喷雾干燥'],
  ['stirring', 'stir', 'stirred', '搅拌'],
  ['aging', 'ageing', 'aged', '陈化', '老化'],
  ['washing', 'wash', 'washed', '洗涤', '水洗'],
  ['filtration', 'filter', 'filtered', '过滤'],
  ['centrifugation', 'centrifuge', 'centrifuged', '离心'],
  ['hydrothermal', 'hydrothermal treatment', '水热', '水热法', '水热处理'],
  ['sol-gel', 'sol gel', 'solgel', '溶胶凝胶', '溶胶-凝胶'],
  ['co-precipitation', 'coprecipitation', 'co precipitation', '共沉淀'],
  ['precipitation', 'precipitate', 'precipitated', '沉淀'],
  ['ball-milling', 'ball milling', 'ball milled', '球磨'],
  ['pressing', 'press', 'pressed', '压片', '压制'],
  ['coating', 'coat', 'coated', '涂覆', '涂布'],
  ['evaporation', 'evaporate', 'evaporated', '蒸发'],
  ['combustion', 'combusted', '燃烧', '燃烧法'],
  ['electrospinning', 'electrospun', '静电纺丝'],
  ['etching', 'etch', 'etched', '刻蚀'],
  ['ultrasonication', 'ultrasonic', 'sonication', '超声', '超声处理'],
];

const MATERIAL_GROUPS: string[][] = [
  ['urea', 'carbamide', '尿素', 'ch4n2o'],
  ['sodium hydroxide', 'naoh', '氢氧化钠', '烧碱', 'caustic soda'],
  ['citric acid', 'c6h8o7', '柠檬酸'],
  ['ethylene glycol', 'eg', '乙二醇'],
  ['ethanol', 'c2h5oh', '乙醇', '酒精'],
  ['methanol', 'ch3oh', '甲醇'],
  ['ammonia', 'ammonium hydroxide', 'nh3·h2o', '氨水', '氢氧化铵'],
  ['nitric acid', 'hno3', '硝酸'],
  ['hydrochloric acid', 'hcl', '盐酸'],
  ['sulfuric acid', 'h2so4', '硫酸'],
  ['glucose', 'c6h12o6', '葡萄糖'],
  ['sucrose', '蔗糖'],
  ['polyvinylpyrrolidone', 'pvp', '聚乙烯吡咯烷酮'],
  ['cetyltrimethylammonium bromide', 'ctab', '十六烷基三甲基溴化铵'],
  ['sodium dodecyl sulfate', 'sds', '十二烷基硫酸钠'],
  ['polytetrafluoroethylene', 'ptfe', 'teflon', '聚四氟乙烯'],
  ['acetylene black', '乙炔黑'],
  ['nafion', '全氟磺酸树脂', '全氟磺酸'],
  ['graphene oxide', '氧化石墨烯'],
  ['reduced graphene oxide', 'rgo', '还原氧化石墨烯'],
];

const normalize = (term: string) => term.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

function index(groups: string[][]) {
  const map = new Map<string, string[]>();
  for (const group of groups) {
    const normalized = group.map(normalize);
    for (const term of normalized) map.set(term, normalized);
  }
  return map;
}

const stepIndex = index(STEP_GROUPS);
const materialIndex = index(MATERIAL_GROUPS);

/** All controlled equivalents of a step term; a term outside the table matches only itself. */
export function stepSynonyms(term: string): string[] {
  const key = normalize(term);
  return stepIndex.get(key) ?? [key];
}

/** Reagent aliases. Hydrates and concentration grades are intentionally not merged. */
export function materialSynonyms(term: string): string[] {
  const key = normalize(term);
  return materialIndex.get(key) ?? [key];
}

/** Expand a list for display or matching, de-duplicated. */
export function expandTerms(terms: string[], kind: 'step' | 'material'): string[] {
  const lookup = kind === 'step' ? stepSynonyms : materialSynonyms;
  return [...new Set(terms.flatMap(term => lookup(term)))];
}
