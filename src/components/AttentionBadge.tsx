import { ATTENTION_LABELS, ATTENTION_TONES, type Attention } from '~/lib/deadlines'
import { Badge } from './ui'

export function AttentionBadge({ attention }: { attention: Attention }) {
  return <Badge className={ATTENTION_TONES[attention]}>{ATTENTION_LABELS[attention]}</Badge>
}
