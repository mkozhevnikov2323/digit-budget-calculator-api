// Test-only trusted boundary. Tokens cannot be reconstructed from JSON/IDs/digests.
// This is NOT a production review-proof implementation.
function syntheticWriteTrust() {
  const owners=new WeakMap(),reviews=new WeakMap();
  const lookup=(map,key)=>key && typeof key==='object' ? map.get(key) : undefined;
  return {
    boundary:Object.freeze({
      resolveAuthenticatedOwner:context=>lookup(owners,context),
      resolveVerifiedReview:(context,evidence)=>lookup(owners,context) ? lookup(reviews,evidence) : undefined,
    }),
    owner(owner){const context=Object.freeze({});owners.set(context,{owner});return context;},
    review(context,observation){const evidence=Object.freeze({});const principal=lookup(owners,context);
      if(!principal)throw new Error('Synthetic context required');
      reviews.set(evidence,{kind:'verified_manual_review',owner:principal.owner,...observation});return evidence;},
  };
}
module.exports={syntheticWriteTrust};
