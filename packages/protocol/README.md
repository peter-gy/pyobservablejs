# Python transport codecs

`@pyobservablejs/protocol` owns Python value tags, exact read encoding, and read
request validation. The widget and Deno server consume these codecs. The runtime
continues to operate on native JavaScript values.

Preview encoding has a size budget and may summarize values. Explicit reads
return an exact representation or fail. Binary reads return buffers alongside
metadata so each transport can frame them without base64 conversion.
