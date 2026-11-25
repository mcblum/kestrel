// What other reviewers have said on a request, as one rule words it (`othersSaid`): a grey tick
// and "Dana approved", "2 approved" or "Approved", or plain "Dana requested changes". Never
// coloured: it says where a request stands, not that something needs the user.
import { Check } from 'lucide-react';
import { othersSaid, type OthersReviews } from '@kestrel/server/others-said';

export function OthersSaidNote({ request, className = 'others-said' }: { request: { others?: OthersReviews }; className?: string }) {
  const said = othersSaid(request);
  if (said.kind === 'none') return null;
  return (
    <span className={className} title={said.text}>
      {said.tick && <Check aria-hidden className="others-said-tick" />}
      {said.text}
    </span>
  );
}

/** A request row's status mark when the host says it is approved: the tick in place of the quiet ring. */
export function ApprovedMark({ label }: { label: string }) {
  return (
    <span className="row-dot approved-mark" role="img" aria-label={label} title={label}>
      <Check aria-hidden />
    </span>
  );
}
