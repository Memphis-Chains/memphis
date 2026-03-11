/**
 * Memphis Proactive Assistant
 * 
 * AI that proactively watches your activity and sends
 * helpful insights, suggestions, and reminders via Telegram.
 * 
 * @version 5.0.0
 * @feature WOW-001
 */

import type { Block } from '../memory/chain.js';
import { InsightGenerator, type InsightReport } from './insight-generator.js';
import type { Insight } from './model-e-types.js';
import { ChainStore, type IStore } from './store.js';

export interface AssistantConfig {
  /** Telegram bot token */
  botToken?: string;
  
  /** Telegram chat ID */
  chatId?: string;
  
  /** Check interval in minutes */
  checkIntervalMinutes: number;
  
  /** Enable proactive suggestions */
  enableProactive: boolean;
  
  /** Minimum hours between proactive messages */
  minHoursBetweenMessages: number;
  
  /** Enable mood tracking */
  enableMoodTracking: boolean;
  
  /** Enable productivity tips */
  enableProductivityTips: boolean;
}

export interface ProactiveMessage {
  type: 'suggestion' | 'reminder' | 'insight' | 'mood' | 'tip';
  priority: 'low' | 'medium' | 'high';
  title: string;
  message: string;
  emoji: string;
  timestamp: Date;
  actions?: Array<{ label: string; command: string }>;
}

// ============================================================================
// PROACTIVE ASSISTANT
// ============================================================================

export class ProactiveAssistant {
  private config: AssistantConfig;
  private blocks: Block[];
  private insightGenerator: InsightGenerator;
  private lastMessageTime: Date | null = null;
  private lastMood: string | null = null;
  private readonly store: IStore;

  constructor(blocks: Block[], config: Partial<AssistantConfig> = {}, store: IStore = new ChainStore()) {
    this.blocks = blocks;
    this.config = {
      checkIntervalMinutes: config.checkIntervalMinutes || 30,
      enableProactive: config.enableProactive ?? true,
      minHoursBetweenMessages: config.minHoursBetweenMessages || 2,
      enableMoodTracking: config.enableMoodTracking ?? true,
      enableProductivityTips: config.enableProductivityTips ?? true,
      botToken: config.botToken,
      chatId: config.chatId,
    };
    this.store = store;
    this.insightGenerator = new InsightGenerator(blocks, store);
  }

  /**
   * Check and generate proactive messages
   */
  async check(): Promise<ProactiveMessage[]> {
    const messages: ProactiveMessage[] = [];

    // Check if enough time passed since last message
    if (!this.canSendMessage()) {
      return [];
    }

    // Generate insights
    const report = await this.insightGenerator.generate();

    // 1. Mood change detection
    if (this.config.enableMoodTracking && report.mood !== this.lastMood) {
      messages.push(this.createMoodMessage(report.mood));
      this.lastMood = report.mood;
    }

    // 2. High-priority insights
    const highPriorityInsights = report.insights.filter(i => i.confidence > 0.8);
    if (highPriorityInsights.length > 0) {
      messages.push(this.createInsightMessage(highPriorityInsights[0]));
    }

    // 3. Quick wins
    if (report.quickWins.length > 0) {
      messages.push(this.createQuickWinMessage(report.quickWins));
    }

    // 4. Productivity tips
    if (this.config.enableProductivityTips) {
      const tip = this.generateProductivityTip(report);
      if (tip) {
        messages.push(tip);
      }
    }

    // 5. Inactivity reminder
    const lastActivity = this.getLastActivityTime();
    if (this.shouldRemindAboutInactivity(lastActivity)) {
      messages.push(this.createInactivityReminder(lastActivity));
    }

    // Filter by time constraints
    const eligibleMessages = messages.filter(m => 
      m.priority === 'high' || this.canSendMessage()
    );

    // Update last message time
    if (eligibleMessages.length > 0) {
      this.lastMessageTime = new Date();
      await this.persistMessages(eligibleMessages);
    }

    return eligibleMessages;
  }

  private async persistMessages(messages: ProactiveMessage[]): Promise<void> {
    for (const message of messages) {
      await this.store.append('proactive', {
        type: 'proactive-message',
        source: 'proactive-assistant',
        messageType: message.type,
        priority: message.priority,
        title: message.title,
        message: message.message,
        actions: message.actions,
        timestamp: message.timestamp.toISOString(),
        tags: ['proactive-assistant', message.type, message.priority],
      });
    }
  }

  /**
   * Create mood change message
   */
  private createMoodMessage(mood: string): ProactiveMessage {
    const moodConfig = {
      productive: { emoji: '🔥', title: 'You\'re on fire!', tip: 'Keep the momentum going!' },
      exploring: { emoji: '🔍', title: 'Exploration mode', tip: 'Great time to learn something new!' },
      reflective: { emoji: '💭', title: 'Reflective state', tip: 'Consider capturing your thoughts.' },
      struggling: { emoji: '💪', title: 'Keep pushing', tip: 'Small steps lead to big progress.' },
    };

    const config = moodConfig[mood as keyof typeof moodConfig] || moodConfig.reflective;

    return {
      type: 'mood',
      priority: 'medium',
      title: config.title,
      message: config.tip,
      emoji: config.emoji,
      timestamp: new Date(),
    };
  }

  /**
   * Create insight message
   */
  private createInsightMessage(insight: Insight): ProactiveMessage {
    return {
      type: 'insight',
      priority: 'high',
      title: insight.title,
      message: insight.description,
      emoji: '💡',
      timestamp: new Date(),
      actions: insight.actionable ? [
        { label: 'Take action', command: `/action ${insight.title}` },
      ] : undefined,
    };
  }

  /**
   * Create quick win message
   */
  private createQuickWinMessage(quickWins: string[]): ProactiveMessage {
    const top3 = quickWins.slice(0, 3);
    
    return {
      type: 'suggestion',
      priority: 'medium',
      title: 'Quick Wins Available',
      message: top3.map((w, i) => `${i + 1}. ${w}`).join('\n'),
      emoji: '⚡',
      timestamp: new Date(),
      actions: top3.map((w, i) => ({
        label: `Do ${i + 1}`,
        command: `/quickwin ${i}`,
      })),
    };
  }

  /**
   * Generate productivity tip
   */
  private generateProductivityTip(report: InsightReport): ProactiveMessage | null {
    const hour = new Date().getHours();
    const tips = this.getContextualTips(hour, report.mood);
    
    if (tips.length === 0) return null;
    
    const tip = tips[Math.floor(Math.random() * tips.length)];
    
    return {
      type: 'tip',
      priority: 'low',
      title: 'Productivity Tip',
      message: tip,
      emoji: '🎯',
      timestamp: new Date(),
    };
  }

  /**
   * Get contextual tips based on time and mood
   */
  private getContextualTips(hour: number, mood: string): string[] {
    const tips: string[] = [];

    // Morning tips (6-12)
    if (hour >= 6 && hour < 12) {
      tips.push('Morning is great for deep work. Tackle your hardest task first!');
      tips.push('Consider a quick review of yesterday\'s decisions.');
      tips.push('Set 3 goals for today before diving into work.');
    }
    
    // Afternoon tips (12-18)
    else if (hour >= 12 && hour < 18) {
      tips.push('Post-lunch dip? Try a walking meeting or light task.');
      tips.push('Good time for meetings and collaborative work.');
      tips.push('Review morning progress and adjust afternoon plan.');
    }
    
    // Evening tips (18-24)
    else if (hour >= 18 && hour < 24) {
      tips.push('Wind down with lighter tasks or planning.');
      tips.push('Great time for reflection and journaling.');
      tips.push('Prepare tomorrow\'s priority list.');
    }
    
    // Night tips (0-6)
    else {
      tips.push('Consider if this work is urgent or can wait until morning.');
      tips.push('Night work can be creative, but watch your sleep.');
    }

    // Mood-specific tips
    if (mood === 'struggling') {
      tips.push('Break tasks into smaller pieces. Progress > perfection.');
      tips.push('Take a 5-minute break and come back fresh.');
    } else if (mood === 'productive') {
      tips.push('You\'re in the zone! Minimize distractions.');
      tips.push('Consider documenting what\'s working well today.');
    }

    return tips;
  }

  /**
   * Create inactivity reminder
   */
  private createInactivityReminder(lastActivity: Date): ProactiveMessage {
    const hoursSince = (Date.now() - lastActivity.getTime()) / (1000 * 60 * 60);
    
    return {
      type: 'reminder',
      priority: 'medium',
      title: 'Activity Reminder',
      message: `Haven't seen activity in ${hoursSince.toFixed(1)} hours. Anything to capture?`,
      emoji: '⏰',
      timestamp: new Date(),
      actions: [
        { label: 'Quick journal', command: '/journal' },
        { label: 'Dismiss', command: '/dismiss' },
      ],
    };
  }

  /**
   * Check if can send message
   */
  private canSendMessage(): boolean {
    if (!this.lastMessageTime) return true;
    
    const hoursSince = (Date.now() - this.lastMessageTime.getTime()) / (1000 * 60 * 60);
    return hoursSince >= this.config.minHoursBetweenMessages;
  }

  /**
   * Get last activity time
   */
  private getLastActivityTime(): Date {
    if (this.blocks.length === 0) {
      return new Date(0); // Epoch
    }

    const lastBlock = this.blocks[this.blocks.length - 1];
    if (!lastBlock?.timestamp) {
      return new Date(0);
    }

    return new Date(lastBlock.timestamp);
  }

  /**
   * Check if should remind about inactivity
   */
  private shouldRemindAboutInactivity(lastActivity: Date): boolean {
    const hoursSince = (Date.now() - lastActivity.getTime()) / (1000 * 60 * 60);
    return hoursSince >= 4; // 4 hours
  }

  /**
   * Format message for Telegram
   */
  formatForTelegram(message: ProactiveMessage): string {
    const lines: string[] = [];
    
    lines.push(`${message.emoji} **${message.title}**`);
    lines.push('');
    lines.push(message.message);
    
    if (message.actions && message.actions.length > 0) {
      lines.push('');
      lines.push('_Actions:_');
      for (const action of message.actions) {
        lines.push(`• ${action.command} — ${action.label}`);
      }
    }
    
    return lines.join('\n');
  }

  /**
   * Start periodic checking
   */
  startPeriodicCheck(): NodeJS.Timeout {
    console.log(`🤖 Proactive Assistant started (interval: ${this.config.checkIntervalMinutes}min)`);
    
    return setInterval(async () => {
      const messages = await this.check();
      
      if (messages.length > 0) {
        console.log(`📬 Generated ${messages.length} proactive message(s)`);
        
        // TODO: Send via Telegram if configured
        for (const msg of messages) {
          console.log(`  ${msg.emoji} ${msg.title}`);
        }
      }
    }, this.config.checkIntervalMinutes * 60 * 1000);
  }

  /**
   * Get assistant status
   */
  getStatus(): {
    enabled: boolean;
    lastMessage: Date | null;
    currentMood: string | null;
    checkInterval: number;
  } {
    return {
      enabled: this.config.enableProactive,
      lastMessage: this.lastMessageTime,
      currentMood: this.lastMood,
      checkInterval: this.config.checkIntervalMinutes,
    };
  }
}

// ============================================================================
// PRE-BUILT ASSISTANT PERSONALITIES
// ============================================================================

export const ASSISTANT_PRESETS = {
  /** Minimal - only critical alerts */
  minimal: {
    checkIntervalMinutes: 60,
    enableProactive: true,
    minHoursBetweenMessages: 6,
    enableMoodTracking: false,
    enableProductivityTips: false,
  } as AssistantConfig,

  /** Balanced - helpful but not annoying */
  balanced: {
    checkIntervalMinutes: 30,
    enableProactive: true,
    minHoursBetweenMessages: 2,
    enableMoodTracking: true,
    enableProductivityTips: true,
  } as AssistantConfig,

  /** Active - frequent helpful messages */
  active: {
    checkIntervalMinutes: 15,
    enableProactive: true,
    minHoursBetweenMessages: 1,
    enableMoodTracking: true,
    enableProductivityTips: true,
  } as AssistantConfig,
};
