export default {
  data () {
    return {

    }
  },

  methods: {
    dataType (data) {
      switch (data) {
        case 'string*':
          return 'ABC*'
        case 'string':
          return 'ABC'
        case 'null':
          return 'null'
        case 'integer':
        case 'int':
          return '#'
        case 'float':
        case 'double':
        case 'decimal':
          return '#.##'
        case 'binary':
          return '0101'
        case 'boolean':
          return '0/1'
        case 'array':
          return '[ ]'
        case 'categorical':
          return 'cat'
        case 'date':
        case 'timestamp':
        case 'time':
          return '🕓'
        default:
          return data.substring(0, 3)
      }
    }
  }

}
