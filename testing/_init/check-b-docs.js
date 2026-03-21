const db = db.getSiblingDB('ythril');
const docs = db.general_memories.find({'author.instanceId':'instance-b',seq:{$gt:320}}).sort({seq:1}).toArray();
print('count above 320: ' + docs.length);
docs.forEach(m => print(JSON.stringify({seq:m.seq, fact:m.fact?m.fact.substring(0,30):''})));
