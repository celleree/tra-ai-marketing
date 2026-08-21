# Meta URL Parameters

TRA's Meta ads use URL parameters for external ROI attribution.

The default parameter template is:

`_ef_transaction_id=&source_id=&affid=6&sub1={{campaign.id}}&sub2={{adset.id}}&sub3={{ad.id}}&sub4={{placement}}&sub5=ci&oid=73`

When the app creates a Meta ad creative, it sends this value through Meta's `url_tags` field. The destination URL remains the landing-page URL itself; if the same tracking keys are already present on the destination URL, the publisher removes them before sending the destination to Meta so the parameters are not duplicated.

This applies to both AI-generated creatives and directly uploaded finished creatives because both use the same Meta creative publishing function.

`META_URL_TAGS` can override the default template server-side without changing application code.

Example effective URL structure after Meta resolves its dynamic parameters:

`https://tra.com/sf2?_ef_transaction_id=&source_id=&affid=6&sub1=[campaign ID]&sub2=[ad set ID]&sub3=[ad ID]&sub4=[placement]&sub5=ci&oid=73`

The app must continue creating campaigns, ad sets, and ads as `PAUSED`; URL tracking does not change the existing activation safety boundary.
