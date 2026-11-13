// Provider names mark LTE, base-station (БС) and "white list" endpoints. They
// can be selected with their own quota instead of consuming ordinary nodes.
// The lookahead accepts a trailing digit (for example "БС1"), while the
// leading boundary avoids matching these fragments inside other words.
const SPECIAL_NODE_PATTERN = /(?:^|[^a-zа-яё])(?:lte|бс)(?=$|[^a-zа-яё])|бел(?:ые|ый|ых|ым|ыми|ого|ому)?[\s_-]+спис(?:ок|к[а-яё]*)/iu;

function isSpecialNodeName(name) {
  return SPECIAL_NODE_PATTERN.test(String(name || ''));
}

module.exports = { isSpecialNodeName, SPECIAL_NODE_PATTERN };
