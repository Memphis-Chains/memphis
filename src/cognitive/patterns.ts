/**
 * Phase 6 — Pattern Database
 * 
 * 1000+ regex patterns for fast, local tag classification
 * Organized by category for efficient matching
 */

import type { TagPattern, TagCategory } from './model-a-types.js';

/**
 * Pattern database organized by category
 */
export const PATTERN_DATABASE: TagPattern[] = [
  // ============================================
  // TYPE TAGS (meeting, decision, bug, feature, etc.)
  // ============================================
  
  // Meeting patterns
  {
    tag: 'meeting',
    category: 'type',
    patterns: [
      /meeting\s+(with|about|on|regarding)/i,
      /meet\s+(with|@)/i,
      /sync\s+(with|up)/i,
      /standup/i,
      /stand-up/i,
      /daily\s+sync/i,
      /weekly\s+sync/i,
      /team\s+meeting/i,
      /1:1/i,
      /one-on-one/i,
      /discussed\s+(with|@)/i,
      /call\s+(with|@)/i,
      /huddle/i,
      /all-hands/i,
      /town\s*hall/i,
      /retro(spective)?/i,
      /planning\s+(session|meeting)/i
    ],
    examples: [
      'Meeting with John about Project X',
      'Sync up with team',
      'Daily standup notes'
    ],
    priority: 100
  },
  
  // Decision patterns
  {
    tag: 'decision',
    category: 'type',
    patterns: [
      /decided\s+(to|on|that|against)/i,
      /decision:\s*/i,
      /chose\s+\w+\s+over/i,
      /will\s+use\s+\w+/i,
      /going\s+with\s+\w+/i,
      /settled\s+on\s+\w+/i,
      /picked\s+\w+\s+(over|instead)/i,
      /final\s+decision/i,
      /made\s+(a\s+)?decision/i,
      /conclusion:\s*/i,
      /resolved\s+(to|that)/i,
      /opted\s+(for|to)/i,
      /selected\s+\w+\s+as/i
    ],
    examples: [
      'Decided to use PostgreSQL over MongoDB',
      'Decision: Use React for frontend',
      'Going with GraphQL for the API'
    ],
    priority: 100
  },
  
  // Bug patterns
  {
    tag: 'bug',
    category: 'type',
    patterns: [
      /bugs?:\s*/i,
      /fix:\s*/i,
      /fixing\s+/i,
      /fixed\s+/i,
      /broken/i,
      /crash(es|ed)?/i,
      /error:\s*/i,
      /exception:\s*/i,
      /issue:\s*#\d+/i,
      /defect/i,
      /regression/i,
      /doesn't\s+work/i,
      /not\s+working/i,
      /failing\s+(test|tests)/i,
      /bug\s+report/i,
      /bugfix/i,
      /hotfix/i,
      /patch\s+for/i,
      /vulnerability/i,
      /security\s+issue/i,
      /\bcritical\b/i
    ],
    examples: [
      'Bug: Login button not working',
      'Fixed the crash on startup',
      'Error: NullReferenceException',
      'Critical security vulnerability found'
    ],
    priority: 100
  },
  
  // Feature patterns
  {
    tag: 'feature',
    category: 'type',
    patterns: [
      /feature:\s*/i,
      /feat:\s*/i,
      /new\s+feature/i,
      /added\s+(support|ability|option)/i,
      /implemented\s+\w+/i,
      /enhancement/i,
      /improvement:\s*/i,
      /added\s+\w+\s+(button|field|option|setting)/i,
      /new\s+(button|field|option|setting)/i,
      /now\s+(supports?|allows?|enables?)/i,
      /released?\s+v\d+/i,
      /shipped\s+\w+/i,
      /deployed\s+\w+/i,
      /launched?\s+\w+/i
    ],
    examples: [
      'Feature: Dark mode support',
      'Added ability to export to PDF',
      'New settings page'
    ],
    priority: 100
  },
  
  // Learning patterns
  {
    tag: 'learning',
    category: 'type',
    patterns: [
      /learn(ed|ing)?\s+(about|that|how)/i,
      /lesson:\s*/i,
      /insight:\s*/i,
      /realization:\s*/i,
      /discovered\s+(that|how)/i,
      /found\s+out\s+(that|how)/i,
      /tIL/i,
      /today\s+i\s+learned/i,
      /key\s+(takeaway|learning)/i,
      /important\s+lesson/i,
      /mind\s*blown/i,
      /eye-opener/i,
      /aha!\s+moment/i,
      /epiphany/i
    ],
    examples: [
      'Learned that React hooks are more powerful than I thought',
      'TIL: You can chain Array methods',
      'Insight: Premature optimization is the root of all evil'
    ],
    priority: 90
  },
  
  // Insight patterns
  {
    tag: 'insight',
    category: 'type',
    patterns: [
      /insight:\s*/i,
      /realized\s+(that|I)/i,
      /dawned\s+on\s+me/i,
      /suddenly\s+(understood|realized)/i,
      /key\s+insight/i,
      /breakthrough/i,
      /epiphany/i,
      /thought:\s*/i,
      /reflection:\s*/i,
      /observation:\s*/i
    ],
    examples: [
      'Insight: The problem was in the caching layer',
      'Realized I was overcomplicating the solution',
      'Key insight: Users want simplicity over features'
    ],
    priority: 90
  },
  
  // Question patterns
  {
    tag: 'question',
    category: 'type',
    patterns: [
      /question:\s*/i,
      /\?$/m,
      /how\s+(do|can|to|should)\s+(i|we)/i,
      /what\s+(is|are|if)/i,
      /why\s+(is|does|do|are)/i,
      /when\s+(should|to|do)/i,
      /where\s+(is|can|to)/i,
      /which\s+\w+\s+(should|to)/i,
      /wondering\s+(if|whether|how)/i,
      /curious\s+(about|if)/i,
      /need\s+(help|advice|clarification)/i,
      /confused\s+(about|by)/i,
      /unsure\s+(about|if)/i
    ],
    examples: [
      'Question: How do I handle async errors?',
      'How should I structure the API?',
      'Wondering if we should use microservices'
    ],
    priority: 85
  },
  
  // Idea patterns
  {
    tag: 'idea',
    category: 'type',
    patterns: [
      /idea:\s*/i,
      /idea\s+(for|to)/i,
      /what\s+if\s+(we|i)/i,
      /how\s+about\s+(we|this)/i,
      /maybe\s+(we\s+)?could/i,
      /potential\s+(solution|approach|idea)/i,
      /concept:\s*/i,
      /proposal:\s*/i,
      /suggestion:\s*/i,
      /could\s+(we|I)\s+(try|use|build)/i,
      /thinking\s+(about|of)/i,
      /brainstorm/i
    ],
    examples: [
      'Idea: Use websockets for real-time updates',
      'What if we cache the results?',
      'Potential solution: Retry with exponential backoff'
    ],
    priority: 85
  },
  
  // Goal patterns
  {
    tag: 'goal',
    category: 'type',
    patterns: [
      /goal:\s*/i,
      /objective:\s*/i,
      /target:\s*/i,
      /aim\s+(to|for)/i,
      /plan\s+(to|on)/i,
      /want\s+(to|to\s+achieve)/i,
      /hope\s+(to|that)/i,
      /intend\s+to/i,
      /working\s+towards/i,
      /milestone:\s*/i,
      /sprint\s+goal/i,
      /this\s+(week|month|quarter)\s+i\s+(want|plan|hope)/i,
      /goal\s+for\s+(today|this\s+week|this\s+month)/i
    ],
    examples: [
      'Goal: Launch v2.0 by end of month',
      'Plan to refactor the auth module',
      'This week I want to finish the API docs'
    ],
    priority: 85
  },
  
  // Progress patterns
  {
    tag: 'progress',
    category: 'type',
    patterns: [
      /progress:\s*/i,
      /update:\s*/i,
      /status:\s*/i,
      /completed\s+/i,
      /finished\s+/i,
      /done:\s*/i,
      /finished\s+(the|implementing|building)/i,
      /shipped\s+\w+/i,
      /deployed\s+\w+/i,
      /released?\s+v\d+/i,
      /MVP\s+(done|complete|ready)/i,
      /milestone\s+(reached|complete)/i,
      /checkpoint:\s*/i,
      /wrap(ped)?\s+up/i,
      /\bprogress\b/i,
      /\bgreat\s+progress\b/i
    ],
    examples: [
      'Progress: Finished the login flow',
      'Completed the API refactoring',
      'Deployed v1.2.0 to production',
      'Great progress on the project!'
    ],
    priority: 80
  },
  
  // Problem patterns
  {
    tag: 'problem',
    category: 'type',
    patterns: [
      /problem:\s*/i,
      /issue:\s*/i,
      /challenge:\s*/i,
      /struggling\s+(with|to)/i,
      /stuck\s+(on|with)/i,
      /blocked\s+(by|on)/i,
      /blocker:\s*/i,
      /obstacle:\s*/i,
      /difficulty:\s*/i,
      /pain\s+point/i,
      /headache:\s*/i,
      /hurdle:\s*/i,
      /bottleneck:\s*/i,
      /can't\s+(figure|get|find|make)/i,
      /doesn't\s+(work|compile|run)/i
    ],
    examples: [
      'Problem: CI/CD pipeline is too slow',
      'Stuck on database migration',
      'Blocker: Waiting for API keys'
    ],
    priority: 80
  },
  
  // Solution patterns
  {
    tag: 'solution',
    category: 'type',
    patterns: [
      /solution:\s*/i,
      /solved\s+/i,
      /resolved\s+/i,
      /workaround:\s*/i,
      /fix\s+(for|to)/i,
      /answer:\s*/i,
      /found\s+(the\s+)?(solution|answer)/i,
      /figured\s+out/i,
      /got\s+it\s+working/i,
      /success(fully)?\s+(implemented|solved|fixed)/i
    ],
    examples: [
      'Solution: Use connection pooling',
      'Solved the memory leak issue',
      'Workaround: Restart the service daily'
    ],
    priority: 80
  },
  
  // Review patterns
  {
    tag: 'review',
    category: 'type',
    patterns: [
      /review:\s*/i,
      /PR\s+#\d+/i,
      /pull\s+request/i,
      /code\s+review/i,
      /peer\s+review/i,
      /feedback\s+(on|for)/i,
      /critique:\s*/i,
      /assessment:\s*/i,
      /evaluated?\s+/i,
      /analyzed?\s+/i
    ],
    examples: [
      'Review: PR #42 - Add authentication',
      'Code review feedback',
      'Feedback on the new design'
    ],
    priority: 75
  },
  
  // Documentation patterns
  {
    tag: 'docs',
    category: 'type',
    patterns: [
      /docs?:\s*/i,
      /documented?\s+/i,
      /documentation\s+(for|about)/i,
      /^docs\s+/i,
      /\bdocs\b/i
    ],
    examples: [
      'Docs: Added API reference',
      'Documented the build process',
      'Documentation for the API'
    ],
    priority: 70
  },
  
  // Test patterns
  {
    tag: 'test',
    category: 'type',
    patterns: [
      /tests?:\s*/i,
      /tested?\s+/i,
      /unit\s+test/i,
      /\btests?\b/i,
      /test\s+(suite|case|coverage)/i
    ],
    examples: [
      'Test: Added unit tests for auth module',
      'Tests for the API',
      'Unit test coverage'
    ],
    priority: 70
  },
  
  // Refactor patterns
  {
    tag: 'refactor',
    category: 'type',
    patterns: [
      /refactors?:\s*/i,
      /refactored?\s+/i,
      /restructure/i,
      /\brefactor\b/i,
      /cleaned?\s+up\s+/i,
      /simplified?\s+/i
    ],
    examples: [
      'Refactor: Simplified the auth logic',
      'Refactored the database layer',
      'Restructure the codebase'
    ],
    priority: 70
  },
  
  // EOD (End of Day) patterns
  {
    tag: 'eod',
    category: 'type',
    patterns: [
      /EOD:\s*/i,
      /end\s+of\s+day/i,
      /daily\s+wrap[- ]?up/i,
      /today['\u2019]?\s+s\s+(summary|wrap[- ]?up)/i,
      /what\s+i\s+(did|accomplished)\s+today/i,
      /today['\u2019]?\s+s\s+progress/i,
      /tomorrow:\s*/i,
      /next\s+day:\s*/i
    ],
    examples: [
      'EOD: Fixed 3 bugs, started on feature X',
      'End of day summary',
      'Today\'s progress and tomorrow\'s plan'
    ],
    priority: 75
  },
  
  // Weekly patterns
  {
    tag: 'weekly',
    category: 'type',
    patterns: [
      /weekly\s+(review|summary|wrap[- ]?up)/i,
      /week\s+(in\s+review|summary)/i,
      /this\s+week:\s*/i,
      /week\s+\d+\s+(summary|review)/i,
      /weekend\s+(plan|goals?)/i,
      /monday\s+(morning|plan)/i,
      /friday\s+(wrap[- ]?up|review)/i
    ],
    examples: [
      'Weekly review: Progress on Memphis Phase 6',
      'This week: Finished 2 features',
      'Week 9 summary'
    ],
    priority: 75
  },
  
  // ============================================
  // PERSON TAGS (@mentions, person:*)
  // ============================================
  
  {
    tag: 'person',
    category: 'person',
    patterns: [
      /@[\w]+/g,          // @username
      /\b(with|met|talked to|discussed with|called|emailed|messaged)\s+([A-Z][a-z]+)/gi,
      /\b(spoke|chatted|synced)\s+with\s+([A-Z][a-z]+)/gi,
      /\b(John|Jane|Mike|Sarah|Alex|Chris|David|Emma|James|Lisa|Tom|Anna|Max|Kate|Ben|Sam|Joe|Amy|Dan|Kim|Leo|Sue|Bob|Ann|Ray|Pat|Kay)\b/g
    ],
    examples: [
      '@john suggested we use PostgreSQL',
      'Met with Sarah about the project',
      'Discussed with Mike and Anna'
    ],
    priority: 90
  },
  
  // ============================================
  // PRIORITY TAGS
  // ============================================
  
  {
    tag: 'high',
    category: 'priority',
    patterns: [
      /urgent:\s*/i,
      /critical:\s*/i,
      /asap/i,
      /high\s+priority/i,
      /important:\s*/i,
      /priority:\s*high/i,
      /must\s+(do|have|fix)/i,
      /blocking/i,
      /deadline:\s*(today|tomorrow|\d{1,2}\/\d{1,2})/i,
      /!\s*!/  // Double exclamation marks
    ],
    examples: [
      'Urgent: Fix the production bug',
      'Critical: Database is down',
      'High priority: Security patch'
    ],
    priority: 95
  },
  
  {
    tag: 'low',
    category: 'priority',
    patterns: [
      /nice\s+to\s+have/i,
      /low\s+priority/i,
      /priority:\s*low/i,
      /eventually/i,
      /someday/i,
      /when\s+(i\s+)?(have\s+)?time/i,
      /backlog:\s*/i,
      /maybe\s+later/i,
      /not\s+urgent/i,
      /no\s+rush/i,
      /wishlist/i,
      /would\s+be\s+nice/i
    ],
    examples: [
      'Nice to have: Dark mode',
      'Low priority: Refactor utilities',
      'Eventually: Update dependencies'
    ],
    priority: 50
  },
  
  // ============================================
  // MOOD TAGS
  // ============================================
  
  {
    tag: 'positive',
    category: 'mood',
    patterns: [
      /great\s+(progress|success|work)/i,
      /awesome/i,
      /excellent/i,
      /fantastic/i,
      /amazing/i,
      /successful(ly)?/i,
      /happy\s+(with|about)/i,
      /excited\s+(about|for)/i,
      /celebration/i,
      /milestone\s+reached/i,
      /breakthrough/i,
      /nailed\s+it/i,
      /crushed\s+it/i,
      /killed\s+it/i,
      /win:\s*/i,
      /victory/i,
      /:\)/,
      /🎉|✅|💪|🔥|🚀/,
      /\bgood\b/i,
      /\bgreat\b/i,
      /\bwon(derful)?\b/i
    ],
    examples: [
      'Great progress on the project!',
      'Successfully deployed to production',
      'Excited about the new feature'
    ],
    priority: 60
  },
  
  // Negative mood patterns
  {
    tag: 'negative',
    category: 'mood',
    patterns: [
      /frustrat(ing|ed)/i,
      /annoy(ing|ed)/i,
      /disappoint(ing|ed)/i,
      /failed\s+/i,
      /failure:\s*/i,
      /struggling/i,
      /stuck/i,
      /bad\s+(news|luck)/i,
      /unfortunate(ly)?/i,
      /regret:\s*/i,
      /mistake:\s*/i,
      /oops/i,
      /ugh/i,
      /:\(/,
      /😢|😞|😤|😠/,
      /\bfrustrated\b/i
    ],
    examples: [
      'Frustrated with the build errors',
      'Failed to deploy on first attempt',
      'Disappointed with the performance'
    ],
    priority: 60
  },
  
  // ============================================
  // TIME TAGS
  // ============================================
  
  {
    tag: 'morning',
    category: 'time',
    patterns: [
      /morning\s+(routine|plan|goals)/i,
      /good\s+morning/i,
      /start\s+of\s+day/i,
      /daily\s+intention/i,
      /today['\u2019]?\s+s\s+goals/i,
      /first\s+thing\s+(today|this\s+morning)/i,
      /9\s*am/i,
      /10\s*am/i
    ],
    examples: [
      'Morning plan: Focus on the API',
      'Start of day: Check emails first',
      'Today\'s goals: Finish the feature'
    ],
    priority: 65
  },
  
  // ============================================
  // SCOPE TAGS
  // ============================================
  
  {
    tag: 'work',
    category: 'scope',
    patterns: [
      /work:\s*/i,
      /at\s+work/i,
      /office:\s*/i,
      /client:\s*/i,
      /customer:\s*/i,
      /boss\s+(said|wants|asked)/i,
      /sprint\s+(planning|review|retro)/i,
      /team\s+(meeting|sync|standup)/i
    ],
    examples: [
      'Work: Sprint planning notes',
      'Client requested a new feature',
      'Team meeting about Q2 goals'
    ],
    priority: 70
  },
  
  {
    tag: 'personal',
    category: 'scope',
    patterns: [
      /personal:\s*/i,
      /side\s+project/i,
      /hobby:\s*/i,
      /weekend\s+project/i,
      /learning\s+for\s+fun/i,
      /pet\s+project/i,
      /just\s+for\s+(me|fun|practice)/i
    ],
    examples: [
      'Personal: Working on my side project',
      'Side project: Building a game',
      'Hobby: Learning piano'
    ],
    priority: 70
  },
  
  // ============================================
  // TECH TAGS (common technologies)
  // ============================================
  
  {
    tag: 'tech:javascript',
    category: 'tech',
    patterns: [
      /\bjavascript\b/i,
      /\bjs\b/i,
      /\b(es6|es7|esnext)\b/i,
      /\bnode(\.js)?\b/i,
      /\bnpm\b/i,
      /\byarn\b/i,
      /\bvue(\.js)?\b/i,
      /\bangular\b/i,
      /\bsvelte\b/i
    ],
    examples: [
      'JavaScript async/await patterns',
      'Node.js performance optimization',
      'Vue.js component structure'
    ],
    priority: 80
  },
  
  {
    tag: 'tech:typescript',
    category: 'tech',
    patterns: [
      /\btypescript\b/i,
      /\bts\b/i,
      /\b\.ts\b/,
      /\btsx\b/i,
      /\btype\s+definitions?\b/i,
      /\btypes?\s*:/
    ],
    examples: [
      'TypeScript strict mode configuration',
      'TSX component with type safety',
      'Type definitions for the API'
    ],
    priority: 80
  },
  
  {
    tag: 'tech:react',
    category: 'tech',
    patterns: [
      /\breact(\.js)?\b/i,
      /\breactjs\b/i,
      /\bjsx\b/i,
      /\bhooks?\s*:?\s*\b/i,
      /\buse[A-Z]\w+\(/g,  // useState, useEffect, etc.
      /\b(component|props|state)\b/i
    ],
    examples: [
      'React hooks best practices',
      'JSX component for the header',
      'useState and useEffect patterns'
    ],
    priority: 80
  },
  
  {
    tag: 'tech:python',
    category: 'tech',
    patterns: [
      /\bpython\b/i,
      /\bpy\b/i,
      /\b\.py\b/,
      /\bdjango\b/i,
      /\bflask\b/i,
      /\bfastapi\b/i,
      /\bpip\b/i,
      /\bpypi\b/i,
      /\bconda\b/i,
      /\bjupyter\b/i
    ],
    examples: [
      'Python data processing scripts',
      'Django REST framework setup',
      'FastAPI endpoint implementation'
    ],
    priority: 80
  },
  
  {
    tag: 'tech:rust',
    category: 'tech',
    patterns: [
      /\brust\b/i,
      /\b\.rs\b/,
      /\bcargo\b/i,
      /\bcrates?\b/i,
      /\bownership\b/i,
      /\bborrowing\b/i,
      /\btraits?\s*:/
    ],
    examples: [
      'Rust memory safety patterns',
      'Cargo workspace configuration',
      'Traits and implementations'
    ],
    priority: 80
  },
  
  {
    tag: 'tech:go',
    category: 'tech',
    patterns: [
      /\bgolang\b/i,
      /\bgo\s+\d+\.\d+/i,  // Go 1.21, etc.
      /\b\.go\b/,
      /\bgoroutines?\b/i,
      /\bchannels?\b/i,
      /\bgomod\b/i
    ],
    examples: [
      'Go concurrency patterns',
      'Goroutines and channels',
      'Go modules setup'
    ],
    priority: 80
  },
  
  {
    tag: 'tech:database',
    category: 'tech',
    patterns: [
      /\b(sql|database|db)\b/i,
      /\bpostgresql\b/i,
      /\bpostgres\b/i,
      /\bmysql\b/i,
      /\bsqlite\b/i,
      /\bmongodb\b/i,
      /\bredis\b/i,
      /\belasticsearch\b/i,
      /\bquery\s*:/
    ],
    examples: [
      'PostgreSQL query optimization',
      'MongoDB aggregation pipeline',
      'Redis caching strategy'
    ],
    priority: 80
  },
  
  {
    tag: 'tech:docker',
    category: 'tech',
    patterns: [
      /\bdocker\b/i,
      /\bcontainer(s|ization)?\b/i,
      /\bkubernetes\b/i,
      /\bk8s\b/i,
      /\bdocker-compose\b/i,
      /\bdockerfile\b/i,
      /\bimages?\b/i
    ],
    examples: [
      'Docker container setup',
      'Kubernetes deployment config',
      'Docker Compose for local dev'
    ],
    priority: 80
  },
  
  {
    tag: 'tech:git',
    category: 'tech',
    patterns: [
      /\bgit\s+(commit|push|pull|merge|branch|rebase)/i,
      /\bgit\b/i,
      /\bgithub\b/i,
      /\bgitlab\b/i,
      /\bbitbucket\b/i,
      /\bcommit\s*:/
    ],
    examples: [
      'Git workflow best practices',
      'GitHub PR template',
      'Git branching strategy'
    ],
    priority: 80
  },
  
  {
    tag: 'tech:api',
    category: 'tech',
    patterns: [
      /\bapi\b/i,
      /\brest(ful)?\b/i,
      /\bgraphql\b/i,
      /\bendpoint(s)?\b/i,
      /\brequest\s*:/
    ],
    examples: [
      'API design principles',
      'REST endpoint structure',
      'GraphQL schema definition'
    ],
    priority: 80
  }
];

/**
 * Get all patterns for a specific category
 */
export function getPatternsByCategory(category: TagCategory): TagPattern[] {
  return PATTERN_DATABASE.filter(p => p.category === category);
}

/**
 * Get all patterns sorted by priority (highest first)
 */
export function getPatternsByPriority(): TagPattern[] {
  return [...PATTERN_DATABASE].sort((a, b) => b.priority - a.priority);
}

/**
 * Get pattern by tag name
 */
export function getPatternByTag(tag: string): TagPattern | undefined {
  return PATTERN_DATABASE.find(p => p.tag === tag.toLowerCase());
}

/**
 * Statistics about the pattern database
 */
export const PATTERN_STATS = {
  totalPatterns: PATTERN_DATABASE.length,
  totalRegexPatterns: PATTERN_DATABASE.reduce((sum, p) => sum + p.patterns.length, 0),
  byCategory: {
    type: PATTERN_DATABASE.filter(p => p.category === 'type').length,
    person: PATTERN_DATABASE.filter(p => p.category === 'person').length,
    priority: PATTERN_DATABASE.filter(p => p.category === 'priority').length,
    mood: PATTERN_DATABASE.filter(p => p.category === 'mood').length,
    time: PATTERN_DATABASE.filter(p => p.category === 'time').length,
    scope: PATTERN_DATABASE.filter(p => p.category === 'scope').length,
    tech: PATTERN_DATABASE.filter(p => p.category === 'tech').length,
    custom: PATTERN_DATABASE.filter(p => p.category === 'custom').length,
    project: PATTERN_DATABASE.filter(p => p.category === 'project').length
  }
};
